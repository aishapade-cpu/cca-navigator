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
const MAX_CANDIDATE_STUDIES = 200;
const AI_ENRICH_LIMIT = 30;
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

function getRadiusMiles(radiusInput) {
  if (radiusInput == null || radiusInput === '' || radiusInput === 'any') return null;
  const parsed = Number(radiusInput);
  if (!Number.isFinite(parsed)) return DEFAULT_RADIUS_MILES;
  return ALLOWED_RADIUS_MILES.has(parsed) ? parsed : DEFAULT_RADIUS_MILES;
}

async function fetchRecruitingStudies({ userCoords = null, userZip = null, radiusMiles = DEFAULT_RADIUS_MILES } = {}) {
  const studies = [];
  let nextPageToken = null;

  do {
    const params = new URLSearchParams({
      'query.cond': 'cholangiocarcinoma',
      'filter.overallStatus': 'RECRUITING',
      pageSize: String(CT_PAGE_SIZE),
      format: 'json',
    });
    if (userCoords && radiusMiles != null) {
      params.set('filter.geo', `distance(${userCoords.lat},${userCoords.lon},${radiusMiles}mi)`);
    }
    if (nextPageToken) params.set('pageToken', nextPageToken);

    const ctRes = await fetch(`${CT_BASE}?${params}`);
    if (!ctRes.ok) throw new Error(`ClinicalTrials.gov error: ${ctRes.status}`);

    const ctData = await ctRes.json();
    studies.push(...(ctData.studies || []));
    nextPageToken = ctData.nextPageToken || null;
  } while (nextPageToken && studies.length < MAX_CANDIDATE_STUDIES);

  return studies.slice(0, MAX_CANDIDATE_STUDIES);
}

async function fetchRecruitingStudiesWithFallback({ userCoords = null, userZip = null, radiusMiles = DEFAULT_RADIUS_MILES } = {}) {
  const withLocation = await fetchRecruitingStudies({ userCoords, userZip, radiusMiles });
  if (withLocation.length > 0 || (!userCoords && !userZip)) {
    return { studies: withLocation, usedLocationFilter: !!(userCoords && radiusMiles != null) || !!userZip, fellBackToNationwide: false };
  }

  // If location-filtered search yields nothing, retry nationwide so users still see options.
  const nationwide = await fetchRecruitingStudies({ userCoords: null, userZip: null, radiusMiles: null });
  return { studies: nationwide, usedLocationFilter: true, fellBackToNationwide: true };
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/find-trials', async (req, res) => {
  const { age, zip, radius, stage, ccaType, forWhom, treatments, freetext } = req.body;
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
    } = await fetchRecruitingStudiesWithFallback({ userCoords, userZip, radiusMiles });
    const eligibleStudies = allRecruitingStudies.filter(s => isAgeEligible(s, hasUserAge ? userAge : null));
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
    const studiesForAi = orderedEligibleStudies.slice(0, AI_ENRICH_LIMIT);

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

    const stubs = orderedEligibleStudies.map(s => {
      const p = s.protocolSection || {};
      const id = p.identificationModule || {};
      const design = p.designModule || {};
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

    const userProfile = [
      `For: ${forWhom}`,
      age ? `Age: ${age}` : null,
      zip ? `ZIP: ${zip}` : null,
      stage ? `Stage: ${stage}` : null,
      ccaType ? `CCA type: ${ccaType}` : null,
      treatments?.length ? `Prior treatments: ${treatments.join(', ')}` : null,
      freetext ? `Additional notes: ${freetext}` : null,
    ].filter(Boolean).join('\n');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: `You are a compassionate clinical trial navigator helping cholangiocarcinoma patients and families understand clinical trials in plain English.
Respond ONLY with valid JSON. No markdown, no preamble.
You MUST include every single trial provided in your response — do not skip or omit any, even if the trial is overseas or seems less relevant. Patients deserve to know about every option.
Return: {
  "trials": [{ "nctId": string, "plainTitle": string (max 12 words, no jargon), "whatItIs": string (1-2 warm plain-English sentences), "youMayQualify": string (2-3 plain-English conditions this patient likely meets), "watchOut": string (1-2 key things to check with their doctor), "fitScore": "good fit" | "possible fit" | "ask your doctor" }],
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
