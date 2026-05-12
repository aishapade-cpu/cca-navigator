import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import zipcodes from 'zipcodes';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CT_BASE = 'https://clinicaltrials.gov/api/v2/studies';
const CT_PAGE_SIZE = 50;
const MAX_CANDIDATE_STUDIES = 500;
const AI_ENRICH_LIMIT = 15;
const DEFAULT_RADIUS_MILES = 250;
const ALLOWED_RADIUS_MILES = new Set([25, 50, 100, 250]);

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = deg => (deg * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMiles * c;
}

function getStudyLocationCoords(location) {
  const candidates = [
    { lat: location?.geoPoint?.lat, lon: location?.geoPoint?.lon },
    { lat: location?.geoPoint?.latitude, lon: location?.geoPoint?.longitude },
    { lat: location?.latitude, lon: location?.longitude },
  ];
  for (const c of candidates) {
    const lat = toNumber(c.lat);
    const lon = toNumber(c.lon);
    if (lat != null && lon != null) return { lat, lon };
  }
  return null;
}

function getNearestDistanceMiles(study, userCoords) {
  if (!userCoords) return null;
  const locations = study?.protocolSection?.contactsLocationsModule?.locations || [];
  let min = null;
  for (const loc of locations) {
    const coords = getStudyLocationCoords(loc);
    if (!coords) continue;
    const miles = haversineMiles(userCoords.lat, userCoords.lon, coords.lat, coords.lon);
    if (min == null || miles < min) min = miles;
  }
  return min;
}

function parseAgeYears(ageText) {
  if (!ageText || typeof ageText !== 'string') return null;
  const normalized = ageText.trim().toLowerCase();
  if (!normalized || normalized === 'n/a') return null;
  if (normalized.includes('child') || normalized.includes('adult') || normalized.includes('older adult')) return null;

  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(year|month|week|day)s?/);
  if (!match) return null;

  const value = Number(match[1]);
  const unit = match[2];
  if (Number.isNaN(value)) return null;

  if (unit === 'year') return value;
  if (unit === 'month') return value / 12;
  if (unit === 'week') return value / 52;
  if (unit === 'day') return value / 365;
  return null;
}

function isAgeEligible(study, userAge) {
  if (userAge == null || Number.isNaN(userAge)) return true;
  const elig = study?.protocolSection?.eligibilityModule || {};
  const minAgeYears = parseAgeYears(elig.minimumAge);
  const maxAgeYears = parseAgeYears(elig.maximumAge);
  if (minAgeYears != null && userAge < minAgeYears) return false;
  if (maxAgeYears != null && userAge > maxAgeYears) return false;
  return true;
}

const METASTASIS_SYNONYMS = {
  peritoneum: ['peritoneal', 'peritoneum', 'peritoneal carcinomatosis', 'pipac'],
  liver: ['liver', 'hepatic', 'intrahepatic metastasis'],
  lungs: ['lung', 'pulmonary'],
  bone: ['bone', 'osseous', 'skeletal'],
  'lymph nodes': ['lymph node', 'lymphatic', 'nodal'],
  'adrenal glands': ['adrenal'],
  brain: ['brain', 'cerebral', 'cns metastasis'],
};

const CCA_TYPE_SYNONYMS = {
  intrahepatic: ['intrahepatic', 'icca'],
  extrahepatic: ['extrahepatic', 'ecca', 'distal bile duct'],
  perihilar: ['perihilar', 'klatskin', 'hilar'],
};

function scoreStudyRelevance(study, { metastases = [], freetext = '', ccaType = '' } = {}) {
  const p = study.protocolSection || {};
  const text = [
    p.identificationModule?.briefTitle || '',
    p.descriptionModule?.briefSummary || '',
    p.eligibilityModule?.eligibilityCriteria || '',
    (p.conditionsModule?.keywords || []).join(' '),
  ].join(' ').toLowerCase();

  let score = 0;

  for (const met of metastases) {
    const synonyms = METASTASIS_SYNONYMS[met] || [met];
    if (synonyms.some(s => text.includes(s))) score += 3;
  }

  const freetextTerms = freetext.toLowerCase().split(/[\s,]+/).filter(t => t.length > 2);
  for (const term of freetextTerms) {
    if (text.includes(term)) score += 3;
  }

  const ccaSynonyms = CCA_TYPE_SYNONYMS[ccaType] || [];
  if (ccaSynonyms.some(s => text.includes(s))) score += 1;

  return score;
}

function getRadiusMiles(radiusInput) {
  if (radiusInput == null || radiusInput === '' || radiusInput === 'any') return null;
  const parsed = Number(radiusInput);
  if (!Number.isFinite(parsed)) return DEFAULT_RADIUS_MILES;
  return ALLOWED_RADIUS_MILES.has(parsed) ? parsed : DEFAULT_RADIUS_MILES;
}

const CCA_SEARCH_TERMS = ['cholangiocarcinoma', 'biliary tract cancer'];

async function fetchStudiesByCondition({ conditionTerm, userCoords, radiusMiles, freetext, biomarkerOnly }) {
  const studies = [];
  let nextPageToken = null;

  do {
    const params = new URLSearchParams({
      'query.cond': conditionTerm,
      'filter.overallStatus': 'RECRUITING',
      pageSize: String(CT_PAGE_SIZE),
      format: 'json',
    });
    if (userCoords && radiusMiles != null) {
      params.set('filter.geo', `distance(${userCoords.lat},${userCoords.lon},${radiusMiles}mi)`);
    }
    if (biomarkerOnly && freetext?.trim()) params.set('query.term', freetext.trim());
    if (nextPageToken) params.set('pageToken', nextPageToken);

    const ctRes = await fetch(`${CT_BASE}?${params}`);
    if (!ctRes.ok) throw new Error(`ClinicalTrials.gov error: ${ctRes.status}`);

    const ctData = await ctRes.json();
    studies.push(...(ctData.studies || []));
    nextPageToken = ctData.nextPageToken || null;
  } while (nextPageToken && studies.length < MAX_CANDIDATE_STUDIES);

  return studies;
}

async function fetchRecruitingStudies({ userCoords = null, userZip = null, radiusMiles = DEFAULT_RADIUS_MILES, freetext = null, biomarkerOnly = false } = {}) {
  const results = await Promise.all(
    CCA_SEARCH_TERMS.map(term => fetchStudiesByCondition({ conditionTerm: term, userCoords, radiusMiles, freetext, biomarkerOnly }))
  );

  const seen = new Set();
  const merged = [];
  for (const batch of results) {
    for (const study of batch) {
      const nctId = study?.protocolSection?.identificationModule?.nctId;
      if (nctId && !seen.has(nctId)) {
        seen.add(nctId);
        merged.push(study);
      }
    }
  }

  return merged.slice(0, MAX_CANDIDATE_STUDIES);
}

async function fetchRecruitingStudiesWithFallback({ userCoords = null, userZip = null, radiusMiles = DEFAULT_RADIUS_MILES, freetext = null, biomarkerOnly = false } = {}) {
  const withLocation = await fetchRecruitingStudies({ userCoords, userZip, radiusMiles, freetext, biomarkerOnly });
  if (withLocation.length > 0 || (!userCoords && !userZip)) {
    return { studies: withLocation, usedLocationFilter: !!(userCoords && radiusMiles != null) || !!userZip, fellBackToNationwide: false };
  }

  // If location-filtered search yields nothing, retry nationwide so users still see options.
  const nationwide = await fetchRecruitingStudies({ userCoords: null, userZip: null, radiusMiles: null, freetext, biomarkerOnly });
  return { studies: nationwide, usedLocationFilter: true, fellBackToNationwide: true };
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/find-trials', async (req, res) => {
  const { age, zip, radius, stage, ccaType, forWhom, treatments, freetext, biomarkerOnly, metastases, metastasesOther } = req.body;
  const userAge = Number(age);
  const hasUserAge = !Number.isNaN(userAge) && userAge > 0;
  const userZip = String(zip || '').trim();
  const userZipMatch = zipcodes.lookup(userZip);
  const radiusMiles = getRadiusMiles(radius);
  const userCoords = userZipMatch
    ? { lat: userZipMatch.latitude, lon: userZipMatch.longitude }
    : null;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const {
      studies: allRecruitingStudies,
      usedLocationFilter,
      fellBackToNationwide,
    } = await fetchRecruitingStudiesWithFallback({ userCoords, userZip, radiusMiles, freetext, biomarkerOnly });
    const CCA_ELIGIBILITY_TERMS = ['cholangiocarcinoma', 'bile duct', 'biliary', 'cca', 'klatskin', 'perihilar', 'intrahepatic', 'extrahepatic', 'hepatobiliary', 'biliary tract', 'solid tumor', 'solid tumour', 'malignancy', 'malignancies', 'advanced cancer', 'refractory cancer'];
    const isCcaRelevant = s => {
      const text = (s.protocolSection?.eligibilityModule?.eligibilityCriteria || '').toLowerCase();
      if (!text) return true;
      return CCA_ELIGIBILITY_TERMS.some(t => text.includes(t));
    };
    const eligibleStudies = allRecruitingStudies.filter(s => isAgeEligible(s, hasUserAge ? userAge : null) && isCcaRelevant(s));
    const rankedEligibleStudies = eligibleStudies
      .map(study => ({
        study,
        nearestDistanceMiles: getNearestDistanceMiles(study, userCoords),
      }))
      .sort((a, b) => {
        const aDist = a.nearestDistanceMiles ?? Number.POSITIVE_INFINITY;
        const bDist = b.nearestDistanceMiles ?? Number.POSITIVE_INFINITY;
        if (aDist !== bDist) return aDist - bDist;
        const aNct = a.study?.protocolSection?.identificationModule?.nctId || '';
        const bNct = b.study?.protocolSection?.identificationModule?.nctId || '';
        return aNct.localeCompare(bNct);
      });

    const orderedEligibleStudies = rankedEligibleStudies.map(x => x.study);
    const distanceByNctId = Object.fromEntries(
      rankedEligibleStudies.map(x => [
        x.study?.protocolSection?.identificationModule?.nctId,
        x.nearestDistanceMiles,
      ]).filter(([id]) => !!id)
    );
    const studiesForAi = [...orderedEligibleStudies]
      .sort((a, b) => {
        const aScore = scoreStudyRelevance(a, { metastases, freetext, ccaType });
        const bScore = scoreStudyRelevance(b, { metastases, freetext, ccaType });
        if (bScore !== aScore) return bScore - aScore;
        const aDist = distanceByNctId[a?.protocolSection?.identificationModule?.nctId] ?? Infinity;
        const bDist = distanceByNctId[b?.protocolSection?.identificationModule?.nctId] ?? Infinity;
        return aDist - bDist;
      })
      .slice(0, AI_ENRICH_LIMIT);

    if (!orderedEligibleStudies.length) {
      send('done', {
        trials: [],
        doctorQuestions: [],
        counts: {
          retrieved: allRecruitingStudies.length,
          filteredOutByAge: allRecruitingStudies.length,
          eligible: 0,
          aiEnriched: 0,
          displayed: 0,
        },
      });
      res.end();
      return;
    }

    const aiNctIds = new Set(studiesForAi.map(s => s.protocolSection?.identificationModule?.nctId));

    const stubs = orderedEligibleStudies.map(s => {
      const p = s.protocolSection || {};
      const id = p.identificationModule || {};
      const design = p.designModule || {};
      const desc = p.descriptionModule || {};
      const elig = p.eligibilityModule || {};
      const contacts = p.contactsLocationsModule || {};
      const locs = contacts.locations || [];
      const centralContacts = (contacts.centralContacts || []).map(c => ({
        name: c.name,
        email: c.email || null,
        phone: c.phone || null,
      }));
      return {
        nctId: id.nctId,
        officialTitle: id.briefTitle,
        phases: design.phases || [],
        locations: (userCoords
          ? [...locs].sort((a, b) => {
              const da = (() => { const c = getStudyLocationCoords(a); return c ? haversineMiles(userCoords.lat, userCoords.lon, c.lat, c.lon) : Infinity; })();
              const db = (() => { const c = getStudyLocationCoords(b); return c ? haversineMiles(userCoords.lat, userCoords.lon, c.lat, c.lon) : Infinity; })();
              return da - db;
            })
          : locs).slice(0, 4).map(l => ({ facility: l.facility, city: l.city, state: l.state })),
        nearestDistanceMiles: distanceByNctId[id.nctId] ?? null,
        url: `https://clinicaltrials.gov/study/${id.nctId}`,
        contacts: centralContacts,
        briefSummary: (desc.briefSummary || '').trim(),
        minAge: elig.minimumAge || null,
        maxAge: elig.maximumAge || null,
        isObservational: (design.studyType || '').toUpperCase() === 'OBSERVATIONAL',
        pendingAi: aiNctIds.has(id.nctId),
        relevanceScore: scoreStudyRelevance(s, { metastases, freetext, ccaType }),
      };
    });

    send('trials', {
      trials: stubs,
      counts: {
        retrieved: allRecruitingStudies.length,
        filteredOutByAge: allRecruitingStudies.length - orderedEligibleStudies.length,
        eligible: orderedEligibleStudies.length,
        aiEnriched: Math.min(studiesForAi.length, AI_ENRICH_LIMIT),
        displayed: stubs.length,
        usedLocationFilter,
        fellBackToNationwide,
      },
    });

    const trialSummaries = studiesForAi.map((s, i) => {
      const p = s.protocolSection || {};
      const id = p.identificationModule || {};
      const elig = p.eligibilityModule || {};
      const desc = p.descriptionModule || {};
      const design = p.designModule || {};
      const locs = p.contactsLocationsModule?.locations || [];
      const sortedLocs = userCoords
        ? [...locs].sort((a, b) => {
            const ca = getStudyLocationCoords(a); const cb = getStudyLocationCoords(b);
            const da = ca ? haversineMiles(userCoords.lat, userCoords.lon, ca.lat, ca.lon) : Infinity;
            const db = cb ? haversineMiles(userCoords.lat, userCoords.lon, cb.lat, cb.lon) : Infinity;
            return da - db;
          })
        : locs;
      const locationStr = sortedLocs.slice(0, 3).map(l => [l.city, l.state].filter(Boolean).join(', ')).join(' | ');
      return `[${i + 1}] NCT ID: ${id.nctId}
Title: ${id.briefTitle}
Phase: ${(design.phases || []).join(', ')}
Locations: ${locationStr || 'Multiple US sites'}
Summary: ${(desc.briefSummary || '').substring(0, 400)}
Eligibility: ${(elig.eligibilityCriteria || '').substring(0, 600)}
Age: ${elig.minimumAge || '18 years'} – ${elig.maximumAge || 'no max'}`;
    }).join('\n\n---\n\n');

    const metastasesList = [
      ...(metastases || []),
      ...(metastasesOther?.trim() ? [metastasesOther.trim()] : []),
    ];
    const userProfile = [
      `For: ${forWhom}`,
      age ? `Age: ${age}` : null,
      zip ? `ZIP: ${zip}` : null,
      stage ? `Stage: ${stage}` : null,
      ccaType ? `CCA type: ${ccaType}` : null,
      metastasesList.length ? `Cancer has spread to: ${metastasesList.join(', ')}` : null,
      treatments?.length ? `Prior treatments: ${treatments.join(', ')}` : null,
      freetext ? `Additional notes: ${freetext}` : null,
    ].filter(Boolean).join('\n');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: `You are a compassionate clinical trial navigator helping cholangiocarcinoma patients and families understand clinical trials in plain English.
Respond ONLY with valid JSON. No markdown, no preamble.
You MUST include every single trial provided in your response — do not skip or omit any, even if the trial is overseas or seems less relevant. Patients deserve to know about every option.
In the whatItIs field, lead with plain English. Where clinical terms add value, include them in parentheses immediately after the plain-English equivalent — e.g. 'cancer spread to the belly lining (peritoneal carcinomatosis)' or 'a targeted therapy for a specific gene change (FGFR2 fusion)'. Never lead with jargon.

Use this rubric for fitScore. Err toward "strong" or "possible" — only use "check" when there is a clear, explicit conflict:
"strong": No obvious eligibility conflict and the core criteria align — the patient's stage, CCA type (if specified by the trial), and treatment history don't conflict with the trial's requirements. Spread location matching the trial's focus (e.g. peritoneal mets for a PIPAC trial) is a strong positive signal. Broad trials that accept CCA patients without specific exclusions qualify as strong if the patient's profile fits. Phase is a positive signal (Phase 2+ or expansion cohort = stronger) but not a gate — missing or early phase alone should not prevent a "strong" rating.
"possible": Likely relevant but something meaningful is unknown — CCA type or stage not specified by patient and the trial is type- or stage-specific; treatment history unclear and the trial has treatment-line requirements; basket trial where CCA is one of many cancers and the patient's profile doesn't clearly align with the trial's focus.
"check": An explicit conflict exists — requires a specific biomarker the patient has not confirmed; clear treatment line mismatch (e.g. trial is explicitly first-line only but patient has had prior systemic therapy, or trial requires prior treatment but patient has had none); trial explicitly excludes the patient's CCA type or stage; or the trial's eligibility criteria are written for a different cancer and CCA is only incidentally listed.

If a trial requires a specific biomarker or mutation that the patient has NOT confirmed in their profile, set fitScore to "check" and note in watchOut that tumor testing for that biomarker is required before enrolling.
Return: {
  "trials": [{ "nctId": string, "plainTitle": string (max 12 words, no jargon), "whatItIs": string (1-2 warm plain-English sentences), "youMayQualify": string (2-3 plain-English conditions this patient likely meets), "watchOut": string (1-2 key things to check with their doctor), "fitScore": "strong" | "possible" | "check", "biomarkerMatch": boolean (true ONLY if the trial explicitly targets, requires, or is designed around a specific biomarker or mutation mentioned in the patient profile — e.g. an IDH1-inhibitor trial when the patient has an IDH1 mutation. Must be false for general CCA trials that happen to be a good fit), "requiresBiomarker": boolean (true if the trial requires the patient's tumor to be tested for or confirmed to express a specific biomarker or mutation before enrolling — regardless of whether the patient has that biomarker) }],
  "doctorQuestions": string[] (5 specific personalized questions to bring to their oncologist)
}`,
      messages: [{ role: 'user', content: `Patient profile:\n${userProfile}\n\nTrials:\n\n${trialSummaries}` }]
    });

    let parsed;
    try {
      const raw = message.content[0].text.replace(/```json|```/g, '').trim().replace(/[\r\n]+/g, ' ');
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Failed to parse AI response: ${e.message}`);
    }

    const aiMap = {};
    (parsed.trials || []).forEach(t => { aiMap[t.nctId] = t; });

    const enrichedTrials = stubs.map(trial => ({
      ...trial,
      ai: aiMap[trial.nctId] || null,
    }));

    send('done', {
      trials: enrichedTrials,
      doctorQuestions: parsed.doctorQuestions || [],
      counts: {
        retrieved: allRecruitingStudies.length,
        filteredOutByAge: allRecruitingStudies.length - orderedEligibleStudies.length,
        eligible: orderedEligibleStudies.length,
        aiEnriched: studiesForAi.length,
        displayed: enrichedTrials.length,
        usedLocationFilter,
        fellBackToNationwide,
      },
    });
    res.end();

  } catch (err) {
    console.error('Error:', err);
    send('error', { message: err.message });
    res.end();
  }
});

app.post('/api/enrich-trial', async (req, res) => {
  const { nctId, userProfile } = req.body;
  try {
    const ctRes = await fetch(`${CT_BASE}/${nctId}?format=json`);
    if (!ctRes.ok) throw new Error(`CT.gov error: ${ctRes.status}`);
    const study = await ctRes.json();
    const p = study.protocolSection || {};
    const id = p.identificationModule || {};
    const elig = p.eligibilityModule || {};
    const desc = p.descriptionModule || {};
    const design = p.designModule || {};
    const locs = p.contactsLocationsModule?.locations || [];
    const locationStr = locs.slice(0, 3).map(l => [l.city, l.state].filter(Boolean).join(', ')).join(' | ');

    const trialSummary = `NCT ID: ${id.nctId}
Title: ${id.briefTitle}
Phase: ${(design.phases || []).join(', ')}
Locations: ${locationStr || 'Multiple US sites'}
Summary: ${(desc.briefSummary || '').substring(0, 400)}
Eligibility: ${(elig.eligibilityCriteria || '').substring(0, 600)}
Age: ${elig.minimumAge || '18 years'} – ${elig.maximumAge || 'no max'}`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: `You are a compassionate clinical trial navigator helping cholangiocarcinoma patients and families understand clinical trials in plain English.
Respond ONLY with valid JSON. No markdown, no preamble.
In the whatItIs field, lead with plain English. Where clinical terms add value, include them in parentheses.
Use this rubric for fitScore — err toward "strong" or "possible", only use "check" for explicit conflicts. "strong": no obvious eligibility conflict, core criteria align (stage, CCA type if specified, treatment history), phase is a positive signal but not a gate. "possible": likely relevant but something meaningful is unknown (type/stage unspecified and trial is specific, treatment history unclear, basket trial where patient's profile doesn't clearly align). "check": explicit conflict only — unconfirmed required biomarker, clear treatment line mismatch, trial explicitly excludes patient's CCA type or stage.
If a trial requires a specific biomarker the patient has NOT confirmed, set fitScore to "check" and note in watchOut that tumor testing is required.
Return: { "nctId": string, "plainTitle": string (max 12 words), "whatItIs": string (1-2 sentences), "youMayQualify": string (2-3 conditions), "watchOut": string (1-2 things to check), "fitScore": "strong" | "possible" | "check", "biomarkerMatch": boolean, "requiresBiomarker": boolean (true if the trial requires tumor testing for a specific biomarker before enrolling) }`,
      messages: [{ role: 'user', content: `Patient profile:\n${userProfile}\n\nTrial:\n${trialSummary}` }],
    });

    const raw = message.content[0].text.replace(/```json|```/g, '').trim().replace(/[\r\n]+/g, ' ');
    const ai = JSON.parse(raw);
    res.json({ ai });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/outreach-message', async (req, res) => {
  const { nctId, plainTitle, userProfile } = req.body;
  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: `You write warm, brief emails for cancer patients contacting clinical trial teams. Respond with ONLY the email text, no subject line, no explanation.`,
      messages: [{ role: 'user', content: `Write a 2-sentence email from a patient/family member asking about eligibility for trial ${nctId} ("${plainTitle}"). Patient profile: ${userProfile}. Sign off as "A patient inquiry via CCA Navigator".` }]
    });
    res.json({ message: message.content[0].text.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CCA Navigator running on port ${PORT}`));
