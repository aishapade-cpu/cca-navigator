const API_BASE = '';

// Show/hide biomarker filter toggle based on freetext content
document.addEventListener('DOMContentLoaded', () => {
  const freetext = document.getElementById('freetext');
  const wrap = document.getElementById('biomarker-filter-wrap');
  freetext.addEventListener('input', () => {
    wrap.style.display = freetext.value.trim() ? 'flex' : 'none';
  });
});

// --- Form persistence ---

function saveFormData() {
  const data = {
    forWhom: document.getElementById('for-whom').value,
    ccaType: document.getElementById('cca-type').value,
    stage: document.getElementById('stage').value,
    age: document.getElementById('age').value,
    zip: document.getElementById('zip').value,
    radius: document.getElementById('radius').value,
    freetext: document.getElementById('freetext').value,
    biomarkerOnly: document.getElementById('biomarker-only').checked,
    treatments: getChecked('treatments'),
    metastases: getChecked('metastases'),
    metastasesOther: document.getElementById('metastases-other').value,
  };
  localStorage.setItem('formData', JSON.stringify(data));
}

function restoreFormData() {
  try {
    const data = JSON.parse(localStorage.getItem('formData') || '{}');
    if (!Object.keys(data).length) return;
    if (data.forWhom) document.getElementById('for-whom').value = data.forWhom;
    if (data.ccaType) document.getElementById('cca-type').value = data.ccaType;
    if (data.stage) document.getElementById('stage').value = data.stage;
    if (data.age) document.getElementById('age').value = data.age;
    if (data.zip) document.getElementById('zip').value = data.zip;
    if (data.radius) document.getElementById('radius').value = data.radius;
    if (data.freetext) {
      document.getElementById('freetext').value = data.freetext;
      document.getElementById('biomarker-filter-wrap').style.display = 'flex';
    }
    if (data.biomarkerOnly) document.getElementById('biomarker-only').checked = data.biomarkerOnly;
    if (data.metastases?.length) {
      document.querySelectorAll('#metastases input[type=checkbox]').forEach(cb => {
        cb.checked = data.metastases.includes(cb.value);
      });
    }
    if (data.metastasesOther) document.getElementById('metastases-other').value = data.metastasesOther;
    if (data.treatments?.length) {
      document.querySelectorAll('#treatments input[type=checkbox]').forEach(cb => {
        cb.checked = data.treatments.includes(cb.value);
      });
    }
  } catch { /* ignore */ }
}

// --- Saved trials (localStorage) ---

function getSaved() {
  try { return JSON.parse(localStorage.getItem('savedTrials') || '{}'); } catch { return {}; }
}

function saveTrial(trial) {
  const saved = getSaved();
  saved[trial.nctId] = trial;
  localStorage.setItem('savedTrials', JSON.stringify(saved));
  updateSavedUI();
}

function unsaveTrial(nctId) {
  const saved = getSaved();
  delete saved[nctId];
  localStorage.setItem('savedTrials', JSON.stringify(saved));
  updateSavedUI();
}

function isSaved(nctId) {
  return !!getSaved()[nctId];
}

function updateSavedUI() {
  const count = Object.keys(getSaved()).length;
  const link = document.getElementById('saved-link');
  const countEl = document.getElementById('saved-count');
  countEl.textContent = count;
  link.style.display = count > 0 ? 'block' : 'none';

  // update all save buttons on the page
  document.querySelectorAll('[data-save-nct]').forEach(btn => {
    const nctId = btn.dataset.saveNct;
    btn.classList.toggle('saved', isSaved(nctId));
    btn.title = isSaved(nctId) ? 'Remove from saved' : 'Save trial';
  });
}

function toggleSave(nctId) {
  if (isSaved(nctId)) {
    unsaveTrial(nctId);
  } else {
    const cardEl = document.getElementById(`trial-${nctId}`);
    const trial = cardEl?._trialData;
    if (trial) saveTrial(trial);
  }
}

async function generateSummaryForTrial(nctId, btn) {
  btn.textContent = 'Generating...';
  btn.disabled = true;

  const formData = JSON.parse(localStorage.getItem('formData') || '{}');
  const userProfile = [
    formData.forWhom ? `For: ${formData.forWhom}` : null,
    formData.age ? `Age: ${formData.age}` : null,
    formData.stage ? `Stage: ${formData.stage}` : null,
    formData.ccaType ? `CCA type: ${formData.ccaType}` : null,
    formData.treatments?.length ? `Prior treatments: ${formData.treatments.join(', ')}` : null,
    formData.freetext ? `Additional notes: ${formData.freetext}` : null,
  ].filter(Boolean).join(', ');

  try {
    const res = await fetch('/api/enrich-trial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nctId, userProfile }),
    });
    const data = await res.json();
    if (!data.ai) throw new Error('No summary returned');

    const card = document.getElementById(`trial-${nctId}`);
    if (!card) return;
    const trial = { ...card._trialData, ai: data.ai, pendingAi: false };
    const newCard = renderTrialCard(trial);
    card.replaceWith(newCard);
  } catch {
    btn.textContent = 'Generate plain-English summary';
    btn.disabled = false;
  }
}

async function generateOutreach(nctId, plainTitle, btn) {
  btn.textContent = 'Generating...';
  btn.disabled = true;

  const formData = JSON.parse(localStorage.getItem('formData') || '{}');
  const userProfile = [
    formData.forWhom ? `For: ${formData.forWhom}` : null,
    formData.age ? `Age: ${formData.age}` : null,
    formData.stage ? `Stage: ${formData.stage}` : null,
    formData.ccaType ? `CCA type: ${formData.ccaType}` : null,
    formData.treatments?.length ? `Prior treatments: ${formData.treatments.join(', ')}` : null,
  ].filter(Boolean).join(', ');

  try {
    const res = await fetch('/api/outreach-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nctId, plainTitle, userProfile }),
    });
    const data = await res.json();
    const textEl = document.getElementById(`outreach-${nctId}`);
    textEl.textContent = data.message;
    textEl.style.display = 'block';
    btn.style.display = 'none';
    document.getElementById(`copy-btn-${nctId}`).style.display = 'inline-block';
  } catch {
    btn.textContent = 'Generate message';
    btn.disabled = false;
  }
}

function copyOutreach(nctId, btn) {
  const text = document.getElementById(`outreach-${nctId}`)?.textContent;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy message'; }, 2000);
  });
}

function showSaved() {
  const saved = Object.values(getSaved());
  const container = document.getElementById('saved-container');
  container.innerHTML = '';

  if (!saved.length) {
    container.innerHTML = `<div class="empty-state"><h3>No saved trials yet</h3><p>Hit the bookmark icon on any trial to save it here.</p></div>`;
  } else {
    saved.forEach(t => container.appendChild(renderTrialCard(t, true)));
  }

  document.getElementById('saved-back-btn').onclick = () => show('screen-results');
  show('screen-saved');
}

function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function getChecked(containerId) {
  return Array.from(document.querySelectorAll(`#${containerId} input[type=checkbox]:checked`))
    .map(cb => cb.value);
}

const loadingMessages = [
  'Searching ClinicalTrials.gov...',
  'Reading eligibility criteria...',
  'Generating plain-language summaries...',
];

let loadingTimer;

function startLoadingCycle() {
  let i = 0;
  const el = document.getElementById('loading-msg');
  el.textContent = loadingMessages[0];
  loadingTimer = setInterval(() => {
    i = Math.min(i + 1, loadingMessages.length - 1);
    el.textContent = loadingMessages[i];
  }, 5000);
}

function stopLoadingCycle() { clearInterval(loadingTimer); }

document.getElementById('intake-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('form-error');
  errEl.style.display = 'none';

  const body = {
    forWhom: document.getElementById('for-whom').value,
    ccaType: document.getElementById('cca-type').value,
    stage: document.getElementById('stage').value,
    age: document.getElementById('age').value,
    zip: document.getElementById('zip').value,
    radius: document.getElementById('radius').value,
    freetext: document.getElementById('freetext').value,
    biomarkerOnly: document.getElementById('biomarker-only').checked,
    treatments: getChecked('treatments'),
    metastases: getChecked('metastases'),
    metastasesOther: document.getElementById('metastases-other').value,
  };

  saveFormData();
  show('screen-loading');
  startLoadingCycle();

  try {
    const res = await fetch(`${API_BASE}/api/find-trials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Server error');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let phase1Rendered = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.trials && !parsed.doctorQuestions) {
            stopLoadingCycle();
            renderPhase1(parsed);
            phase1Rendered = true;
          } else if (parsed.trials && parsed.doctorQuestions !== undefined) {
            stopLoadingCycle();
            if (phase1Rendered) {
              renderPhase2(parsed);
            } else {
              renderResults(parsed);
            }
          } else if (parsed.message) {
            throw new Error(parsed.message);
          }
        } catch (e) {
          if (e.message && !e.message.includes('JSON')) throw e;
        }
      }
    }
  } catch (err) {
    stopLoadingCycle();
    show('screen-intake');
    errEl.textContent = `Something went wrong: ${err.message}. Please try again.`;
    errEl.style.display = 'block';
  }
});

document.getElementById('back-btn').addEventListener('click', () => show('screen-intake'));

updateSavedUI();
restoreFormData();

function renderPhase1(data) {
  const trials = [...(data.trials || [])].sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
    const aDist = Number.isFinite(a.nearestDistanceMiles) ? a.nearestDistanceMiles : Infinity;
    const bDist = Number.isFinite(b.nearestDistanceMiles) ? b.nearestDistanceMiles : Infinity;
    return aDist - bDist;
  });
  document.getElementById('results-title').textContent =
    trials.length ? `${trials.length} matching trial${trials.length !== 1 ? 's' : ''} found` : 'No trials found right now';
  document.getElementById('results-sub').textContent = trials.length
    ? 'Showing recruiting trials sorted by relevance. Plain-English summaries are loading...'
    : 'ClinicalTrials.gov updates regularly — check back soon.';

  const container = document.getElementById('trials-container');
  container.innerHTML = '';

  const progressBar = document.createElement('div');
  progressBar.className = 'results-progress-bar';
  progressBar.id = 'results-progress-bar';
  document.getElementById('screen-results').prepend(progressBar);

  trials.forEach(t => container.appendChild(renderTrialCard(t)));
  document.getElementById('doctor-section').style.display = 'none';
  show('screen-results');
}

function renderPhase2(data) {
  const { doctorQuestions, counts } = data;
  const savedForm = JSON.parse(localStorage.getItem('formData') || '{}');
  const freetextTerms = (savedForm.freetext || '').toLowerCase().split(/[\s,]+/).filter(t => t.length > 2);
  const metastasisSynonyms = {
    peritoneum: ['peritoneal', 'peritoneum', 'peritoneal carcinomatosis', 'pipac'],
    liver: ['liver', 'hepatic'], lungs: ['lung', 'pulmonary'], bone: ['bone', 'osseous'],
    'lymph nodes': ['lymph node', 'lymphatic', 'nodal'], 'adrenal glands': ['adrenal'], brain: ['brain', 'cerebral'],
  };
  const metastasesTerms = (savedForm.metastases || []).flatMap(m => metastasisSynonyms[m] || [m]);

  (data.trials || []).forEach(enriched => {
    const card = document.getElementById(`trial-${enriched.nctId}`);
    if (!card) return;
    const trial = { ...card._trialData, ai: enriched.ai };
    card._trialData = trial;
    const newCard = renderTrialCard(trial);
    card.replaceWith(newCard);
  });

  if (doctorQuestions?.length) {
    document.getElementById('doctor-questions').innerHTML = doctorQuestions.map(q => `<li>${q}</li>`).join('');
    document.getElementById('doctor-section').style.display = 'block';
  }

  document.getElementById('results-progress-bar')?.remove();

  const subEl = document.getElementById('results-sub');
  if (counts?.fellBackToNationwide) {
    subEl.innerHTML = 'No trials found within your selected radius — showing all US trials instead. <strong>Consider widening your search radius or selecting "Any distance."</strong>';
  } else {
    subEl.textContent = 'Summaries ready for top results. Always confirm eligibility with your oncologist.';
  }

  showToast('Summaries ready — <button class="toast-btn" onclick="resortByFit(this)">Re-sort by fit score</button>');
}

function showToast(html) {
  const existing = document.getElementById('results-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'results-toast';
  toast.id = 'results-toast';
  toast.innerHTML = `${html} <button class="toast-dismiss" onclick="this.closest('.results-toast').remove()">✕</button>`;
  document.body.appendChild(toast);

}

function resortByFit(btn) {
  document.getElementById('results-toast')?.remove();
  const container = document.getElementById('trials-container');
  const savedForm = JSON.parse(localStorage.getItem('formData') || '{}');
  const freetextTerms = (savedForm.freetext || '').toLowerCase().split(/[\s,]+/).filter(t => t.length > 2);
  const metastasisSynonyms = {
    peritoneum: ['peritoneal', 'peritoneum', 'peritoneal carcinomatosis', 'pipac'],
    liver: ['liver', 'hepatic'], lungs: ['lung', 'pulmonary'], bone: ['bone', 'osseous'],
    'lymph nodes': ['lymph node', 'lymphatic', 'nodal'], 'adrenal glands': ['adrenal'], brain: ['brain', 'cerebral'],
  };
  const metastasesTerms = (savedForm.metastases || []).flatMap(m => metastasisSynonyms[m] || [m]);
  const hasRelevanceHit = t => {
    const text = [(t.ai?.plainTitle || ''), (t.ai?.whatItIs || ''), (t.officialTitle || '')].join(' ').toLowerCase();
    return freetextTerms.some(term => text.includes(term)) || metastasesTerms.some(term => text.includes(term));
  };

  const cards = [...container.querySelectorAll('.trial-card')];
  cards.sort((a, b) => {
    const at = a._trialData, bt = b._trialData;
    const aScore = fitOrder[at?.ai?.fitScore] ?? 3;
    const bScore = fitOrder[bt?.ai?.fitScore] ?? 3;
    if (aScore !== bScore) return aScore - bScore;
    const aBio = (at?.ai?.biomarkerMatch || hasRelevanceHit(at)) ? 0 : 1;
    const bBio = (bt?.ai?.biomarkerMatch || hasRelevanceHit(bt)) ? 0 : 1;
    if (aBio !== bBio) return aBio - bBio;
    const aReq = (at?.ai?.requiresBiomarker && !at?.ai?.biomarkerMatch) ? 1 : 0;
    const bReq = (bt?.ai?.requiresBiomarker && !bt?.ai?.biomarkerMatch) ? 1 : 0;
    if (aReq !== bReq) return aReq - bReq;
    const aDist = Number.isFinite(at?.nearestDistanceMiles) ? at.nearestDistanceMiles : Infinity;
    const bDist = Number.isFinite(bt?.nearestDistanceMiles) ? bt.nearestDistanceMiles : Infinity;
    return aDist - bDist;
  });
  cards.forEach(c => container.appendChild(c));
}

const fitLabels = {
  strong: 'Strong match',
  possible: 'Possible match',
  check: 'Ask your doctor',
};

function fitLabel(score) {
  return fitLabels[score] || 'Ask your doctor';
}

function fitClass(score) {
  if (score === 'strong') return 'fit-good';
  if (score === 'possible') return 'fit-possible';
  return 'fit-ask';
}

function fitTagClass(score) {
  if (score === 'strong') return 'tag-fit-good';
  if (score === 'possible') return 'tag-fit-possible';
  return 'tag-fit-ask';
}

const fitOrder = { strong: 0, possible: 1, check: 2 };

function renderResults(data) {
  const { doctorQuestions, counts } = data;
  const savedForm = JSON.parse(localStorage.getItem('formData') || '{}');
  const freetextTerms = (savedForm.freetext || '').toLowerCase().split(/[\s,]+/).filter(t => t.length > 2);
  const metastasisSynonyms = {
    peritoneum: ['peritoneal', 'peritoneum', 'peritoneal carcinomatosis', 'pipac'],
    liver: ['liver', 'hepatic'],
    lungs: ['lung', 'pulmonary'],
    bone: ['bone', 'osseous'],
    'lymph nodes': ['lymph node', 'lymphatic', 'nodal'],
    'adrenal glands': ['adrenal'],
    brain: ['brain', 'cerebral'],
  };
  const metastasesTerms = (savedForm.metastases || []).flatMap(m => metastasisSynonyms[m] || [m]);
  if (savedForm.metastasesOther?.trim()) metastasesTerms.push(...savedForm.metastasesOther.toLowerCase().split(/[\s,]+/).filter(t => t.length > 2));

  const hasRelevanceHit = t => {
    const text = [(t.ai?.plainTitle || ''), (t.ai?.whatItIs || ''), (t.officialTitle || '')].join(' ').toLowerCase();
    return freetextTerms.some(term => text.includes(term)) || metastasesTerms.some(term => text.includes(term));
  };

  const trials = [...(data.trials || [])].sort((a, b) => {
    const aScore = fitOrder[a.ai?.fitScore] ?? 3;
    const bScore = fitOrder[b.ai?.fitScore] ?? 3;
    if (aScore !== bScore) return aScore - bScore;
    const aBio = (a.ai?.biomarkerMatch || hasRelevanceHit(a)) ? 0 : 1;
    const bBio = (b.ai?.biomarkerMatch || hasRelevanceHit(b)) ? 0 : 1;
    if (aBio !== bBio) return aBio - bBio;
    const aDistance = Number.isFinite(a.nearestDistanceMiles) ? a.nearestDistanceMiles : Number.POSITIVE_INFINITY;
    const bDistance = Number.isFinite(b.nearestDistanceMiles) ? b.nearestDistanceMiles : Number.POSITIVE_INFINITY;
    return aDistance - bDistance;
  });

  document.getElementById('results-title').textContent =
    trials.length ? `${trials.length} matching trial${trials.length !== 1 ? 's' : ''} found` : 'No trials found right now';

  const subEl = document.getElementById('results-sub');
  if (counts?.fellBackToNationwide) {
    subEl.innerHTML = 'No trials found within your selected radius — showing all US trials instead. <strong>Consider widening your search radius or selecting "Any distance."</strong>';
  } else {
    subEl.textContent = trials.length
      ? 'Showing recruiting trials that may be relevant. Always confirm eligibility with your oncologist.'
      : 'ClinicalTrials.gov updates regularly — check back soon.';
  }

  const container = document.getElementById('trials-container');
  container.innerHTML = '';

  if (!trials.length) {
    container.innerHTML = `<div class="empty-state"><h3>No recruiting trials at this moment</h3><p>Check back in a few weeks, or ask your oncologist about trials not yet publicly listed. The Cholangiocarcinoma Foundation also maintains a list at cholangiocarcinoma.org.</p></div>`;
  } else {
    trials.forEach(t => container.appendChild(renderTrialCard(t)));
  }

  if (doctorQuestions?.length) {
    document.getElementById('doctor-questions').innerHTML =
      doctorQuestions.map(q => `<li>${q}</li>`).join('');
    document.getElementById('doctor-section').style.display = 'block';
  } else {
    document.getElementById('doctor-section').style.display = 'none';
  }

  show('screen-results');
}

const phaseDescriptions = {
  '1': "Phase 1 — Early stage testing. Researchers are checking if it's safe and finding the right dose. It hasn't been proven to work yet, but some patients do respond.",
  '2': 'Phase 2 — The treatment showed promise in Phase 1. Now researchers are testing if it actually helps and continuing to monitor safety.',
  '3': 'Phase 3 — A large, late-stage trial comparing this treatment to the best available option today. These are often the most promising trials.',
  '4': 'Phase 4 — The treatment is already FDA-approved. Researchers are studying its long-term effects in a broader group of patients.',
};

function phaseTooltip(phaseStr) {
  if (/1.+2/i.test(phaseStr)) return 'Phase 1/2 — Safety and effectiveness are tested together in one combined trial. Common in cancer research.';
  if (/2.+3/i.test(phaseStr)) return 'Phase 2/3 — A combined trial testing both whether the treatment works and how it compares to current options.';
  const match = phaseStr.match(/\d/);
  return match ? (phaseDescriptions[match[0]] || phaseStr) : phaseStr;
}

function renderTrialCard(trial, inSavedScreen = false) {
  const ai = trial.ai || null;
  const hasAi = !!ai;
  const isPending = trial.pendingAi && !hasAi;
  const isUnenriched = !hasAi && !isPending;

  const phase = trial.phases.length
    ? trial.phases.map(p => p.replace(/_/g, ' ').replace('PHASE', 'Phase ')).join(', ')
    : null;
  const locationStr = trial.locations.slice(0, 2)
    .map(l => [l.city, l.state].filter(Boolean).join(', '))
    .filter(Boolean).join(' · ');
  const distanceText = Number.isFinite(trial.nearestDistanceMiles)
    ? `${Math.round(trial.nearestDistanceMiles)} mi`
    : null;
  const ageText = (trial.minAge || trial.maxAge)
    ? `Age: ${trial.minAge || '18'} – ${trial.maxAge || 'no max'}`
    : null;

  const saved = isSaved(trial.nctId);
  const saveAction = inSavedScreen
    ? `unsaveTrial('${trial.nctId}'); this.closest('.trial-card').remove(); if (!document.querySelector('#saved-container .trial-card')) showSaved();`
    : `toggleSave('${trial.nctId}')`;

  const rawSummaryToggle = trial.briefSummary
    ? `<details class="trial-raw-summary"><summary>See ClinicalTrials.gov description</summary><p>${trial.briefSummary}</p></details>`
    : '';

  const card = document.createElement('div');
  card.className = `trial-card ${hasAi ? fitClass(ai.fitScore) : ''} ${isPending ? 'card-pending' : ''}`;
  card.id = inSavedScreen ? '' : `trial-${trial.nctId}`;
  card._trialData = { ...trial };
  card.innerHTML = `
    <div class="trial-card-header">
      <div class="trial-tags">
        <span class="tag tag-recruiting">Recruiting</span>
        ${phase ? `<span class="tag tag-phase" data-tooltip="${phaseTooltip(phase)}">${phase}</span>` : ''}
        ${hasAi && ai.requiresBiomarker && !ai.biomarkerMatch ? `<span class="tag tag-biomarker-req">Requires tumor testing</span>` : ''}
      </div>
      <div class="trial-header-right">
        ${hasAi && ai.fitScore ? `<span class="trial-fit-row ${fitTagClass(ai.fitScore)}">${fitLabel(ai.fitScore)}</span>` : ''}
        <button class="save-btn ${saved ? 'saved' : ''}" data-save-nct="${trial.nctId}" title="${saved ? 'Remove from saved' : 'Save trial'}" onclick="${saveAction}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2z"/></svg>
        </button>
      </div>
    </div>
    <div class="trial-plain-title">${hasAi && ai.plainTitle ? ai.plainTitle : trial.officialTitle || 'Clinical trial'}</div>
    <div class="trial-location-top">📍 ${locationStr || 'Multiple US locations'}${distanceText ? ` · ${distanceText}` : ''}</div>
    ${hasAi && trial.officialTitle ? `<div class="trial-official-title">${trial.officialTitle}</div>` : ''}
    <div class="trial-nct">${trial.nctId}</div>
    ${ageText ? `<div class="trial-age-elig">${ageText}</div>` : ''}

    ${isPending ? `<div class="trial-pending-badge">✦ AI summary loading…</div>` : ''}

    ${isUnenriched ? `<button class="generate-summary-btn" onclick="generateSummaryForTrial('${trial.nctId}', this)">Generate plain-English summary</button>` : ''}

    ${hasAi && ai.whatItIs ? `<div class="trial-what">${ai.whatItIs}</div>` : ''}
    ${hasAi && (ai.youMayQualify || ai.watchOut) ? `
      <div class="qualify-blocks">
        ${ai.youMayQualify ? `<div class="qualify-block"><div class="qualify-label">You may qualify if</div><div class="qualify-text">${ai.youMayQualify}</div></div>` : ''}
        ${ai.watchOut ? `<div class="qualify-block"><div class="qualify-label">Worth checking with your doctor</div><div class="qualify-text">${ai.watchOut}</div></div>` : ''}
      </div>` : ''}

    ${rawSummaryToggle}

    ${trial.contacts?.length ? `
    <div class="trial-contacts">
      <div class="contacts-label">Contact the research team</div>
      ${trial.contacts.map(c => `
        <div class="contact-row">
          <span class="contact-name">${c.name}</span>
          <div class="contact-links">
            ${c.email ? `<a class="contact-link" href="mailto:${c.email}">${c.email}</a>` : ''}
            ${c.phone ? `<span class="contact-phone">${c.phone}</span>` : ''}
          </div>
        </div>`).join('')}
      <div class="outreach-block">
        <div class="outreach-label">Suggested message to send</div>
        <div class="outreach-text" id="outreach-${trial.nctId}" style="display:none"></div>
        <button class="generate-btn" id="generate-btn-${trial.nctId}" onclick="generateOutreach('${trial.nctId}', '${(hasAi && ai.plainTitle ? ai.plainTitle : trial.officialTitle || '').replace(/'/g, "\\'")}', this)">Generate message</button>
        <button class="copy-btn" id="copy-btn-${trial.nctId}" style="display:none" onclick="copyOutreach('${trial.nctId}', this)">Copy message</button>
      </div>
    </div>` : ''}
    <div class="trial-footer">
      <a class="trial-link" href="${trial.url}" target="_blank" rel="noopener">View on ClinicalTrials.gov →</a>
    </div>`;
  return card;
}
