const API_BASE = '';

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
    saved.forEach(t => container.appendChild(renderTrialCard(t)));
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
            stopLoadingCycle();
            showTrialStubs(eventData);
          } else if (eventType === 'trial-ai') {
            updateTrialCard(eventData.nctId, eventData.ai);
          } else if (eventType === 'done') {
            if (eventData.doctorQuestions?.length) {
              document.getElementById('doctor-questions').innerHTML =
                eventData.doctorQuestions.map(q => `<li>${q}</li>`).join('');
              document.getElementById('doctor-section').style.display = 'block';
            }
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

function showTrialStubs(data) {
  const { trials, totalFound } = data;

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
    trials.forEach(t => container.appendChild(renderTrialStub(t)));
  }

  document.getElementById('doctor-section').style.display = 'none';
  show('screen-results');
}

function renderTrialStub(trial) {
  const phase = trial.phases.length
    ? trial.phases.map(p => p.replace(/_/g, ' ').replace('PHASE', 'Phase')).join(', ')
    : null;
  const locationStr = trial.locations.slice(0, 2)
    .map(l => [l.city, l.state].filter(Boolean).join(', '))
    .filter(Boolean).join(' · ');

  const card = document.createElement('div');
  card.className = 'trial-card';
  card.id = `trial-${trial.nctId}`;
  card._trialData = { ...trial };
  card.innerHTML = `
    <div class="trial-card-header">
      <div class="trial-tags">
        <span class="tag tag-recruiting">Recruiting</span>
        ${phase ? `<span class="tag tag-phase">${phase}</span>` : ''}
        <span class="tag tag-analyzing">Analyzing...</span>
      </div>
      <button class="save-btn ${isSaved(trial.nctId) ? 'saved' : ''}" data-save-nct="${trial.nctId}" title="${isSaved(trial.nctId) ? 'Remove from saved' : 'Save trial'}" onclick="toggleSave('${trial.nctId}')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2z"/></svg>
      </button>
    </div>
    <div class="trial-plain-title">${trial.officialTitle || 'Clinical trial'}</div>
    <div class="trial-nct">${trial.nctId}</div>
    <div class="trial-ai-placeholder">Generating plain-language summary...</div>
    <div class="trial-footer">
      <span class="trial-location">${locationStr || 'Multiple US locations'}</span>
      <a class="trial-link" href="${trial.url}" target="_blank" rel="noopener">View on ClinicalTrials.gov →</a>
    </div>`;
  return card;
}

function updateTrialCard(nctId, ai) {
  const card = document.getElementById(`trial-${nctId}`);
  if (!card) return;

  card.className = `trial-card ${fitClass(ai.fitScore)}`;

  // merge AI data into stored trial data
  card._trialData = { ...card._trialData, ai };

  // if this trial is saved, update saved data with AI info
  if (isSaved(nctId)) saveTrial(card._trialData);

  const analyzingTag = card.querySelector('.tag-analyzing');
  if (analyzingTag) {
    if (ai.fitScore) {
      analyzingTag.className = `tag ${fitTagClass(ai.fitScore)}`;
      analyzingTag.textContent = ai.fitScore;
    } else {
      analyzingTag.remove();
    }
  }

  if (ai.plainTitle) {
    card.querySelector('.trial-plain-title').textContent = ai.plainTitle;
  }

  let aiContent = '';
  if (ai.whatItIs) aiContent += `<div class="trial-what">${ai.whatItIs}</div>`;
  if (ai.youMayQualify || ai.watchOut) {
    aiContent += `<div class="qualify-blocks">
      ${ai.youMayQualify ? `<div class="qualify-block"><div class="qualify-label">You may qualify if</div><div class="qualify-text">${ai.youMayQualify}</div></div>` : ''}
      ${ai.watchOut ? `<div class="qualify-block"><div class="qualify-label">Worth checking with your doctor</div><div class="qualify-text">${ai.watchOut}</div></div>` : ''}
    </div>`;
  }

  const placeholder = card.querySelector('.trial-ai-placeholder');
  if (placeholder) placeholder.outerHTML = aiContent;
}

function renderTrialCard(trial) {
  const ai = trial.ai || {};
  const phase = trial.phases.length
    ? trial.phases.map(p => p.replace(/_/g, ' ').replace('PHASE', 'Phase')).join(', ')
    : null;
  const locationStr = trial.locations.slice(0, 2)
    .map(l => [l.city, l.state].filter(Boolean).join(', '))
    .filter(Boolean).join(' · ');

  const card = document.createElement('div');
  card.className = `trial-card ${fitClass(ai.fitScore)}`;
  card.innerHTML = `
    <div class="trial-card-header">
      <div class="trial-tags">
        <span class="tag tag-recruiting">Recruiting</span>
        ${phase ? `<span class="tag tag-phase">${phase}</span>` : ''}
        ${ai.fitScore ? `<span class="tag ${fitTagClass(ai.fitScore)}">${ai.fitScore}</span>` : ''}
      </div>
      <button class="save-btn saved" data-save-nct="${trial.nctId}" title="Remove from saved" onclick="unsaveTrial('${trial.nctId}'); this.closest('.trial-card').remove(); if (!document.querySelector('#saved-container .trial-card')) showSaved();">
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
