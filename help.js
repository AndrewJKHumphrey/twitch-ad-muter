function poll() {
  chrome.storage.local.get({ totalMutes: 0 }, (data) => {
    const el = document.getElementById('totalMutes');
    if (el) el.textContent = (data.totalMutes || 0).toLocaleString();
  });
}

poll();
setInterval(poll, 2000);
