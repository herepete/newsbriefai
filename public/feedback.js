(function () {
  const KEY = "nbai_anon_id";

  function getAnonId() {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  }

  function sendVote(tab, vote) {
    fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ymd: document.body.dataset.ymd,
        tab,
        vote,
        anonId: getAnonId(),
      }),
    }).catch(() => {});
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-feedback]");
    if (!btn) return;

    const tab = btn.dataset.tab;
    const vote = btn.dataset.vote;
    sendVote(tab, vote);

    btn.classList.add("voted");
  });
})();

