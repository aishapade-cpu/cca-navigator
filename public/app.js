const API_BASE = '';

// --- Form persistence ---

function saveFormData() {
  const data = {
    forWhom: document.getElementById('for-whom').value,
    ccaType: document.getElementById('cca-type').value,
    stage: document.getElementById('stage').value,
    age: document.getElementById('age').value,
    zip: document.getElementById('zip').value,
    freetext: document.getElementById('freetext').value,
    treatments: getChecked('treatments'),
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
    if (data.freetext) document.getElementById('freetext').value = data.freetext;
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
    freetext: document.getElementById('freetext').value,
    treatments: getChecked('treatments'),
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

    const text = await res.text();
    stopLoadingCycle();

    let doneData = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.trials) doneData = parsed;
        } catch { /* ignore */ }
      }
    }

    if (!doneData) throw new Error('No results received');
    renderResults(doneData);
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

function fitClass(score) {
  if (score === 'good fit') return 'fit-good';
  if (score === 'possible fit') return 'fit-possible';
  return 'fit-ask';
}

function fitTagClass(score) {
  if (score === 'good fit') return 'tag-fit-good';
  if (score === 'possible fit') return 'tag-fit-possible';
  return 'tag-fit-ask';
}

const fitOrder = { 'good fit': 0, 'possible fit': 1, 'ask your doctor': 2 };

function renderResults(data) {
  const { doctorQuestions } = data;
  const trials = [...(data.trials || [])].sort((a, b) => {
    const aScore = fitOrder[a.ai?.fitScore] ?? 3;
    const bScore = fitOrder[b.ai?.fitScore] ?? 3;
    return aScore - bScore;
  });

  document.getElementById('results-title').textContent =
    trials.length ? `${trials.length} matching trial${trials.length !== 1 ? 's' : ''} found` : 'No trials found right now';
  document.getElementById('results-sub').textContent = trials.length
    ? 'Showing recruiting trials that may be relevant. Always confirm eligibility with your oncologist.'
    : 'ClinicalTrials.gov updates regularly — check back soon.';

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

function renderTrialCard(trial, inSavedScreen = false) {
  const ai = trial.ai || null;
  const hasAi = !!ai;
  const phase = trial.phases.length
    ? trial.phases.map(p => p.replace(/_/g, ' ').replace('PHASE', 'Phase')).join(', ')
    : null;
  const locationStr = trial.locations.slice(0, 2)
    .map(l => [l.city, l.state].filter(Boolean).join(', '))
    .filter(Boolean).join(' · ');

  const saved = isSaved(trial.nctId);
  const saveAction = inSavedScreen
    ? `unsaveTrial('${trial.nctId}'); this.closest('.trial-card').remove(); if (!document.querySelector('#saved-container .trial-card')) showSaved();`
    : `toggleSave('${trial.nctId}')`;

  const card = document.createElement('div');
  card.className = `trial-card ${hasAi ? fitClass(ai.fitScore) : ''}`;
  card.id = inSavedScreen ? '' : `trial-${trial.nctId}`;
  card._trialData = { ...trial };
  card.innerHTML = `
    <div class="trial-card-header">
      <div class="trial-tags">
        <span class="tag tag-recruiting">Recruiting</span>
        ${phase ? `<span class="tag tag-phase">${phase}</span>` : ''}
        ${hasAi && ai.fitScore ? `<span class="tag ${fitTagClass(ai.fitScore)}">${ai.fitScore}</span>` : ''}
      </div>
      <button class="save-btn ${saved ? 'saved' : ''}" data-save-nct="${trial.nctId}" title="${saved ? 'Remove from saved' : 'Save trial'}" onclick="${saveAction}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2z"/></svg>
      </button>
    </div>
    <div class="trial-plain-title">${hasAi && ai.plainTitle ? ai.plainTitle : trial.officialTitle || 'Clinical trial'}</div>
    <div class="trial-nct">${trial.nctId}</div>
    ${!hasAi ? `<div class="trial-no-summary">We weren't able to generate a plain-language summary for this trial. <a href="${trial.url}" target="_blank" rel="noopener">View full details on ClinicalTrials.gov →</a></div>` : ''}
    ${hasAi && ai.whatItIs ? `<div class="trial-what">${ai.whatItIs}</div>` : ''}
    ${hasAi && (ai.youMayQualify || ai.watchOut) ? `
      <div class="qualify-blocks">
        ${ai.youMayQualify ? `<div class="qualify-block"><div class="qualify-label">You may qualify if</div><div class="qualify-text">${ai.youMayQualify}</div></div>` : ''}
        ${ai.watchOut ? `<div class="qualify-block"><div class="qualify-label">Worth checking with your doctor</div><div class="qualify-text">${ai.watchOut}</div></div>` : ''}
      </div>` : ''}
    ${trial.contacts?.length || (hasAi && ai.outreachMessage) ? `
    <div class="trial-contacts">
      <div class="contacts-label">Contact the research team</div>
      ${trial.contacts?.map(c => `
        <div class="contact-row">
          <span class="contact-name">${c.name}</span>
          <div class="contact-links">
            ${c.email ? `<a class="contact-link" href="mailto:${c.email}">${c.email}</a>` : ''}
            ${c.phone ? `<span class="contact-phone">${c.phone}</span>` : ''}
          </div>
        </div>`).join('') || ''}
      ${trial.contacts?.length ? `
        <div class="outreach-block">
          <div class="outreach-label">Suggested message to send</div>
          <div class="outreach-text" id="outreach-${trial.nctId}" style="display:none"></div>
          <button class="generate-btn" id="generate-btn-${trial.nctId}" onclick="generateOutreach('${trial.nctId}', '${(hasAi && ai.plainTitle ? ai.plainTitle : trial.officialTitle || '').replace(/'/g, "\\'")}', this)">Generate message</button>
          <button class="copy-btn" id="copy-btn-${trial.nctId}" style="display:none" onclick="copyOutreach('${trial.nctId}', this)">Copy message</button>
        </div>` : ''}
    </div>` : ''}
    <div class="trial-footer">
      <span class="trial-location">${locationStr || 'Multiple US locations'}</span>
      <a class="trial-link" href="${trial.url}" target="_blank" rel="noopener">View on ClinicalTrials.gov →</a>
    </div>`;
  return card;
}
