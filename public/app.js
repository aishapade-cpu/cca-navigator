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

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let trialsMap = {};

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      let eventType = null;
      let eventData = null;

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          try { eventData = JSON.parse(line.slice(6)); } catch { /* ignore */ }
        } else if (line.trim() === '' && eventType && eventData !== null) {
          if (eventType === 'trials') {
            eventData.trials.forEach(t => { trialsMap[t.nctId] = t; });
          } else if (eventType === 'trial-ai') {
            if (trialsMap[eventData.nctId]) {
              trialsMap[eventData.nctId].ai = eventData.ai;
            }
          } else if (eventType === 'done') {
            stopLoadingCycle();
            const trials = Object.values(trialsMap);
            renderResults({ trials, doctorQuestions: eventData.doctorQuestions || [] });
          } else if (eventType === 'error') {
            throw new Error(eventData.message);
          }
          eventType = null;
          eventData = null;
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

function renderResults(data) {
  const { trials, doctorQuestions } = data;

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
  const ai = trial.ai || {};
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
  card.className = `trial-card ${fitClass(ai.fitScore)}`;
  card.id = inSavedScreen ? '' : `trial-${trial.nctId}`;
  card._trialData = { ...trial };
  card.innerHTML = `
    <div class="trial-card-header">
      <div class="trial-tags">
        <span class="tag tag-recruiting">Recruiting</span>
        ${phase ? `<span class="tag tag-phase">${phase}</span>` : ''}
        ${ai.fitScore ? `<span class="tag ${fitTagClass(ai.fitScore)}">${ai.fitScore}</span>` : ''}
      </div>
      <button class="save-btn ${saved ? 'saved' : ''}" data-save-nct="${trial.nctId}" title="${saved ? 'Remove from saved' : 'Save trial'}" onclick="${saveAction}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2z"/></svg>
      </button>
    </div>
    <div class="trial-plain-title">${ai.plainTitle || trial.officialTitle || 'Clinical trial'}</div>
    <div class="trial-nct">${trial.nctId}</div>
    ${ai.whatItIs ? `<div class="trial-what">${ai.whatItIs}</div>` : ''}
    ${(ai.youMayQualify || ai.watchOut) ? `
      <div class="qualify-blocks">
        ${ai.youMayQualify ? `<div class="qualify-block"><div class="qualify-label">You may qualify if</div><div class="qualify-text">${ai.youMayQualify}</div></div>` : ''}
        ${ai.watchOut ? `<div class="qualify-block"><div class="qualify-label">Worth checking with your doctor</div><div class="qualify-text">${ai.watchOut}</div></div>` : ''}
      </div>` : ''}
    <div class="trial-footer">
      <span class="trial-location">${locationStr || 'Multiple US locations'}</span>
      <a class="trial-link" href="${trial.url}" target="_blank" rel="noopener">View on ClinicalTrials.gov →</a>
    </div>`;
  return card;
}
