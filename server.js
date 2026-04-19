import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
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

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/find-trials', async (req, res) => {
  const { age, zip, stage, ccaType, forWhom, treatments, freetext } = req.body;

  try {
    const params = new URLSearchParams({
      'query.cond': 'cholangiocarcinoma',
      'filter.overallStatus': 'RECRUITING',
      'pageSize': '10',
      'format': 'json',
    });

    const ctRes = await fetch(`${CT_BASE}?${params}`);
    if (!ctRes.ok) throw new Error(`ClinicalTrials.gov error: ${ctRes.status}`);
    const ctData = await ctRes.json();
    const studies = (ctData.studies || []).slice(0, 6);

    if (!studies.length) {
      return res.json({ trials: [], doctorQuestions: [], totalFound: 0 });
    }

    const trialSummaries = studies.map((s, i) => {
      const p = s.protocolSection || {};
      const id = p.identificationModule || {};
      const elig = p.eligibilityModule || {};
      const desc = p.descriptionModule || {};
      const design = p.designModule || {};
      const locs = p.contactsLocationsModule?.locations || [];
      const locationStr = locs.slice(0, 3).map(l => [l.city, l.state].filter(Boolean).join(', ')).join(' | ');
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
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: `You are a compassionate clinical trial navigator helping cholangiocarcinoma patients and families understand clinical trials in plain English.
Respond ONLY with valid JSON. No markdown, no preamble.
Return: {
  "trials": [{ "nctId": string, "plainTitle": string (max 12 words, no jargon), "whatItIs": string (1-2 warm plain-English sentences), "youMayQualify": string (2-3 plain-English conditions this patient likely meets), "watchOut": string (1-2 key things to check with their doctor), "fitScore": "good fit" | "possible fit" | "ask your doctor" }],
  "doctorQuestions": string[] (5 specific personalized questions to bring to their oncologist)
}`,
      messages: [{ role: 'user', content: `Patient profile:\n${userProfile}\n\nTrials:\n\n${trialSummaries}` }]
    });

    let parsed;
    try {
      const raw = message.content[0].text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Failed to parse AI response');
    }

    const aiMap = {};
    (parsed.trials || []).forEach(t => { aiMap[t.nctId] = t; });

    const enriched = studies.map(s => {
      const p = s.protocolSection || {};
      const id = p.identificationModule || {};
      const design = p.designModule || {};
      const locs = p.contactsLocationsModule?.locations || [];
      const nctId = id.nctId;
      return {
        nctId,
        officialTitle: id.briefTitle,
        phases: design.phases || [],
        locations: locs.slice(0, 4).map(l => ({ facility: l.facility, city: l.city, state: l.state })),
        url: `https://clinicaltrials.gov/study/${nctId}`,
        ai: aiMap[nctId] || null,
      };
    });

    res.json({ trials: enriched, doctorQuestions: parsed.doctorQuestions || [], totalFound: ctData.totalCount || studies.length });

  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CCA Navigator running on port ${PORT}`));
