const API_BASE = '';

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
    const data = await res.json();
    stopLoadingCycle();
    if (!res.ok) throw new Error(data.error || 'Server error');
    renderResults(data, body.forWhom);
  } catch (err) {
    stopLoadingCycle();
    show('screen-intake');
    errEl.textContent = `Something went wrong: ${err.message}. Please try again.`;
    errEl.style.display = 'block';
  }
});

document.getElementById('back-btn').addEventListener('click', () => show('screen-intake'));

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
    <div class="trial-tags">
      <span class="tag tag-recruiting">Recruiting</span>
      ${phase ? `<span class="tag tag-phase">${phase}</span>` : ''}
      ${ai.fitScore ? `<span class="tag ${fitTagClass(ai.fitScore)}">${ai.fitScore}</span>` : ''}
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

function renderResults(data, forWhom) {
  const { trials, doctorQuestions } = data;
  document.getElementById('results-title').textContent =
    trials.length ? `${trials.length} matching trial${trials.length !== 1 ? 's' : ''} found` : 'No trials found right now';
  document.getElementById('results-sub').textContent = trials.length
    ? `Showing recruiting trials that may be relevant. Always confirm eligibility with your oncologist.`
    : `ClinicalTrials.gov updates regularly — check back soon.`;

  const container = document.getElementById('trials-container');
  container.innerHTML = '';
  if (!trials.length) {
    container.innerHTML = `<div class="empty-state"><h3>No recruiting trials at this moment</h3><p>Check back in a few weeks, or ask your oncologist about trials not yet publicly listed. The Cholangiocarcinoma Foundation also maintains a list at cholangiocarcinoma.org.</p></div>`;
  } else {
    trials.forEach(t => container.appendChild(renderTrialCard(t)));
  }

  if (doctorQuestions?.length) {
    document.getElementById('doctor-questions').innerHTML = doctorQuestions.map(q => `<li>${q}</li>`).join('');
    document.getElementById('doctor-section').style.display = 'block';
  }

  show('screen-results');
}
