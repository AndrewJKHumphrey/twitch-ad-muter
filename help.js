// ── Language ──────────────────────────────────────────────────────────────────

const langSelect = document.getElementById('langSelect');
const aiDisclaimer = document.getElementById('aiDisclaimer');

function applyLang(lang) {
  applyTranslations(lang);
  aiDisclaimer.hidden = (lang === 'en');
}

chrome.storage.local.get({ language: 'en' }, (data) => {
  langSelect.value = data.language;
  applyLang(data.language);
});

langSelect.addEventListener('change', () => {
  const lang = langSelect.value;
  chrome.storage.local.set({ language: lang });
  applyLang(lang);
});

// ── Ads muted counter ─────────────────────────────────────────────────────────

function poll() {
  chrome.storage.local.get({ totalMutes: 0 }, (data) => {
    const el = document.getElementById('totalMutes');
    if (el) el.textContent = (data.totalMutes || 0).toLocaleString();
  });
}

poll();
setInterval(poll, 2000);
