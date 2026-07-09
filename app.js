const targetInput = document.querySelector("#targetInput");
const questionInput = document.querySelector("#questionInput");
const runButton = document.querySelector("#runButton");
const helperText = document.querySelector("#helperText");
const statusBadge = document.querySelector("#statusBadge");
const loadingPanel = document.querySelector("#loadingPanel");
const loadingText = document.querySelector("#loadingText");
const resultPanel = document.querySelector("#resultPanel");
const modeBadge = document.querySelector("#modeBadge");
const groupTitle = document.querySelector("#groupTitle");
const groupSummary = document.querySelector("#groupSummary");
const positiveRatio = document.querySelector("#positiveRatio");
const drivers = document.querySelector("#drivers");
const frictions = document.querySelector("#frictions");
const datasetStatus = document.querySelector("#datasetStatus");
const interviews = document.querySelector("#interviews");

loadStatus();

runButton.addEventListener("click", runResearch);

async function loadStatus() {
  try {
    const response = await fetch("/api/status");
    const status = await response.json();
    statusBadge.textContent = status.keyLoaded ? "Gemini 서버 키 연결됨" : "규칙 기반 엔진";
  } catch {
    statusBadge.textContent = "서버 연결 실패";
  }
}

async function runResearch() {
  const target = targetInput.value.trim();
  const question = questionInput.value.trim();
  if (!target || !question) {
    helperText.textContent = "조사 대상 유저 그룹과 질문을 모두 입력하세요.";
    return;
  }

  setLoading(true, "Nemotron 후보 row를 가져오고 있습니다.");
  try {
    const response = await fetch("/api/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, question })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "요청 실패");
    renderResult(data);
    helperText.textContent = data.notice || "표본 추출과 인터뷰 생성을 완료했습니다.";
  } catch (error) {
    helperText.textContent = error.message;
  } finally {
    setLoading(false);
  }
}

function setLoading(isLoading, text = "") {
  runButton.disabled = isLoading;
  loadingText.textContent = text;
  loadingPanel.classList.toggle("hidden", !isLoading);
}

function renderResult(data) {
  resultPanel.classList.remove("hidden");
  modeBadge.textContent = data.aiMode === "gemini" ? "Gemini AI" : "Fallback Engine";
  groupTitle.textContent = data.group?.title || "그룹 요약";
  groupSummary.textContent = data.group?.summary || "";
  positiveRatio.textContent = data.group?.positiveRatio || "0%";
  drivers.innerHTML = renderChips(data.group?.topDrivers || []);
  frictions.innerHTML = renderChips(data.group?.frictions || []);
  datasetStatus.textContent = `${data.dataset?.name || "Nemotron-Personas-Korea"} · 후보 ${data.dataset?.candidatePool || 0}명 중 ${data.dataset?.selectedCount || 0}명 표본 추출 · ${data.dataset?.type || "합성 페르소나"}`;
  interviews.innerHTML = (data.interviews || []).map(renderInterview).join("");
}

function renderChips(items) {
  return items.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("");
}

function renderInterview(item, index) {
  const values = item.sourceValues || {};
  const score = Number(item.sentimentScore || 0);
  const sentimentClass = score >= 7 ? "good" : score >= 4 ? "mid" : "bad";
  return `
    <article class="interview-card">
      <div class="interview-top">
        <div class="profile">
          <strong>${escapeHtml(item.name || `P${index + 1}`)} · ${escapeHtml(item.polarity || "중립")}</strong>
          <span>${escapeHtml(item.profile || "")}</span>
        </div>
        <span class="sentiment ${sentimentClass}">${score.toFixed(1)} / 10</span>
      </div>
      <blockquote>${escapeHtml(item.answer || "")}</blockquote>
      <p class="reason">이유: ${escapeHtml(item.reason || "")}</p>
      <div class="source-table">
        ${sourceCell("ID", values.id || item.id)}
        ${sourceCell("연령/성별/지역", `${values.age || "미상"} · ${values.sex || "미상"} · ${values.province || "미상"} ${values.district || ""}`)}
        ${sourceCell("직업/학력", `${values.occupation || "미상"} · ${values.education || "미상"}`)}
        ${sourceCell("관심사", values.hobbiesAndInterests || "없음")}
        ${sourceCell("전문 페르소나", values.professionalPersona || "없음")}
        ${sourceCell("생활 페르소나", values.persona || "없음")}
      </div>
    </article>
  `;
}

function sourceCell(label, value) {
  return `<div><strong>${escapeHtml(label)}</strong>${escapeHtml(String(value || ""))}</div>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

