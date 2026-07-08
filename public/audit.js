const openUploadButton = document.getElementById("openUploadButton");
const closeUploadButton = document.getElementById("closeUploadButton");
const uploadModal = document.getElementById("uploadModal");
const imagePreviewModal = document.getElementById("imagePreviewModal");
const imagePreview = document.getElementById("imagePreview");
const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const exportButton = document.getElementById("exportButton");
const statusText = document.getElementById("statusText");
const closeImagePreviewButton = document.getElementById("closeImagePreviewButton");
const itemBody = document.getElementById("itemBody");
const emptyBox = document.getElementById("emptyBox");
const totalCount = document.getElementById("totalCount");
const highCount = document.getElementById("highCount");
const mediumCount = document.getElementById("mediumCount");
const lowCount = document.getElementById("lowCount");
const needsReviewCount = document.getElementById("needsReviewCount");
const tableCount = document.getElementById("tableCount");
const tableTitle = document.querySelector(".table-top h2");
const filterButtons = [...document.querySelectorAll("[data-filter]")];
const sourceSelect = document.getElementById("sourceSelect");
const searchInput = document.getElementById("searchInput");
const sortSelect = document.getElementById("sortSelect");

let auditItems = [];
let activeFilter = "all";
let activeSource = "all";
let searchQuery = "";
let activeSort = "uploadedAt-desc";
let recentReportIds = new Set();

openUploadButton.addEventListener("click", () => {
  uploadModal.classList.remove("hidden");
  setStatus("");
});

closeUploadButton.addEventListener("click", () => {
  uploadModal.classList.add("hidden");
});

uploadModal.addEventListener("click", (event) => {
  if (event.target === uploadModal) uploadModal.classList.add("hidden");
});

closeImagePreviewButton.addEventListener("click", closeImagePreview);

imagePreviewModal.addEventListener("click", (event) => {
  if (event.target === imagePreviewModal) closeImagePreview();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    uploadModal.classList.add("hidden");
    closeImagePreview();
  }
});

fileInput.addEventListener("change", () => {
  uploadFiles([...fileInput.files]);
});

["dragenter", "dragover"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragover");
  });
});

dropZone.addEventListener("drop", (event) => {
  uploadFiles([...event.dataTransfer.files]);
});

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    filterButtons.forEach((item) => item.classList.toggle("active", item === button));
    renderItems(getVisibleItems());
  });
});

sourceSelect.addEventListener("change", () => {
  activeSource = sourceSelect.value;
  renderItems(getVisibleItems());
});

searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value.trim().toLowerCase();
  renderItems(getVisibleItems());
});

sortSelect.addEventListener("change", () => {
  activeSort = sortSelect.value;
  renderItems(getVisibleItems());
});

itemBody.addEventListener("change", async (event) => {
  const checkbox = event.target.closest("[data-needs-review]");
  if (!checkbox) return;
  const item = auditItems.find((entry) => entry.id === checkbox.dataset.needsReview);
  if (!item) return;
  const previousValue = Boolean(item.needsReview);
  item.needsReview = checkbox.checked;
  renderCounts();
  try {
    const response = await fetch(`/api/audit-items/${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ needsReview: checkbox.checked })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "확인필요 저장 실패");
    if (activeFilter === "needsReview") renderItems(getVisibleItems());
  } catch (error) {
    item.needsReview = previousValue;
    checkbox.checked = previousValue;
    renderCounts();
    setStatus(error.message);
  }
});

itemBody.addEventListener("click", async (event) => {
  const previewLink = event.target.closest("[data-image-preview]");
  if (previewLink) {
    event.preventDefault();
    openImagePreview(previewLink.href);
    return;
  }

  const button = event.target.closest("[data-delete-item]");
  if (!button) return;
  const item = auditItems.find((entry) => entry.id === button.dataset.deleteItem);
  const label = item?.screenName || "선택한 분석결과";
  if (!confirm(`"${label}" 분석결과를 삭제할까요?`)) return;
  button.disabled = true;
  button.textContent = "삭제 중";
  try {
    const response = await fetch(`/api/audit-items/${encodeURIComponent(button.dataset.deleteItem)}`, {
      method: "DELETE"
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "삭제 실패");
    await loadItems();
  } catch (error) {
    setStatus(error.message);
    button.disabled = false;
    button.textContent = "삭제";
  }
});

exportButton.addEventListener("click", () => {
  const exportItems = getVisibleItems();
  if (!exportItems.length) {
    setStatus("Export할 검수건이 없습니다.");
    return;
  }
  downloadBlob("dark-pattern-audit-export.xlsx", createExportXlsx(exportItems));
});

async function uploadFiles(files) {
  if (!files.length) return;
  setStatus(`${files.length}개 파일을 업로드하고 데이터를 매칭하는 중입니다.`);
  try {
    const reports = [];
    for (const file of files) {
      const response = await fetch("/api/audit-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: [await fileToPayload(file)] })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "업로드 실패");
      if (data.report?.id) reports.push(data.report);
    }
    recentReportIds = new Set(reports.map((report) => report.id));
    activeSource = reports.length > 1 ? "recent" : reports[0]?.id || "all";
    fileInput.value = "";
    uploadModal.classList.add("hidden");
    await loadItems();
  } catch (error) {
    setStatus(error.message);
  }
}

async function loadItems() {
  const response = await fetch("/api/audit-reports");
  const data = await response.json();
  auditItems = data.items || [];
  renderSourceOptions();
  renderCounts();
  renderItems(getVisibleItems());
}

function renderItems(items) {
  renderCounts();
  const label = searchQuery ? `${filterLabel(activeFilter)} 검색결과` : filterLabel(activeFilter);
  tableTitle.innerHTML = `${escapeHtml(label)} <span id="tableCount">${items.length}</span>`;
  emptyBox.textContent = auditItems.length ? "조건에 맞는 검수건이 없습니다." : "아직 업로드된 검수건이 없습니다.";
  emptyBox.classList.toggle("hidden", items.length > 0);
  itemBody.innerHTML = items.map((item) => `
    <tr>
      <td>${imageCell(item.imageUrl)}</td>
      <td>${escapeHtml(item.screenName || "-")}</td>
      <td><span class="badge ${riskClass(item.riskLevel)}">${escapeHtml(item.riskLevel || "보통")}</span></td>
      <td>${reviewCheckbox(item)}</td>
      <td>${escapeHtml(item.fix || "-")}</td>
      <td>${escapeHtml(item.reason || "-")}</td>
      <td>${escapeHtml(item.checklist || "-")}</td>
      <td>${formatDate(item.uploadedAt)}</td>
      <td><button class="delete-button" type="button" data-delete-item="${escapeHtml(item.id)}">삭제</button></td>
    </tr>
  `).join("");
}

function renderCounts() {
  const sourceItems = getSourceItems();
  totalCount.textContent = sourceItems.length;
  highCount.textContent = sourceItems.filter((item) => item.riskLevel === "위험").length;
  mediumCount.textContent = sourceItems.filter((item) => item.riskLevel === "보통").length;
  lowCount.textContent = sourceItems.filter((item) => item.riskLevel === "낮음").length;
  needsReviewCount.textContent = sourceItems.filter((item) => item.needsReview).length;
}

function getFilteredItems() {
  const sourceItems = getSourceItems();
  if (activeFilter === "all") return sourceItems;
  if (activeFilter === "needsReview") return sourceItems.filter((item) => item.needsReview);
  return sourceItems.filter((item) => item.riskLevel === activeFilter);
}

function getSourceItems() {
  if (activeSource === "recent") return auditItems.filter((item) => recentReportIds.has(item.reportId));
  if (activeSource === "all") return auditItems;
  return auditItems.filter((item) => item.reportId === activeSource);
}

function renderSourceOptions() {
  const reports = new Map();
  auditItems.forEach((item) => {
    if (!item.reportId) return;
    reports.set(item.reportId, item.sourceFileName || item.reportTitle || item.reportId);
  });
  const validSources = new Set(["all", ...reports.keys()]);
  if (recentReportIds.size) validSources.add("recent");
  if (!validSources.has(activeSource)) activeSource = "all";
  const recentOption = recentReportIds.size
    ? `<option value="recent">이번 업로드 (${recentReportIds.size})</option>`
    : "";
  sourceSelect.innerHTML = [
    `<option value="all">전체 파일</option>`,
    recentOption,
    ...[...reports.entries()].map(([id, label]) => `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`)
  ].join("");
  sourceSelect.value = activeSource;
}

function getVisibleItems() {
  return sortItems(searchItems(getFilteredItems()));
}

function searchItems(items) {
  if (!searchQuery) return items;
  return items.filter((item) => searchableText(item).includes(searchQuery));
}

function searchableText(item) {
  return [
    item.imageUrl,
    item.screenName,
    item.riskLevel,
    item.fix,
    item.reason,
    item.checklist,
    item.area,
    item.sourceFileName,
    item.reportTitle
  ].filter(Boolean).join(" ").toLowerCase();
}

function sortItems(items) {
  const riskRank = { "위험": 3, "보통": 2, "낮음": 1 };
  return [...items].sort((left, right) => {
    if (activeSort === "risk-desc") return (riskRank[right.riskLevel] || 0) - (riskRank[left.riskLevel] || 0);
    if (activeSort === "needsReview-desc") return Number(right.needsReview) - Number(left.needsReview);
    if (activeSort === "screenName-asc") return String(left.screenName || "").localeCompare(String(right.screenName || ""), "ko");
    return new Date(right.uploadedAt || 0) - new Date(left.uploadedAt || 0);
  });
}

function filterLabel(value) {
  if (value === "all") return "전체";
  if (value === "needsReview") return "확인필요";
  return value;
}

function reviewCheckbox(item) {
  return `
    <label class="review-check">
      <input type="checkbox" data-needs-review="${escapeHtml(item.id)}" ${item.needsReview ? "checked" : ""}>
      <span>확인필요</span>
    </label>
  `;
}

function imageCell(url) {
  if (!url) return `<span class="image-link">이미지 없음</span>`;
  const absoluteUrl = new URL(url, location.origin).href;
  if (/\.(png|jpg|jpeg)$/i.test(url) || /\/image\d+\.(png|jpg|jpeg)$/i.test(url)) {
    return `<a href="${escapeHtml(absoluteUrl)}" data-image-preview="${escapeHtml(absoluteUrl)}"><img class="thumb" src="${escapeHtml(url)}" alt="화면 이미지"></a>`;
  }
  return `<a class="image-link" href="${escapeHtml(absoluteUrl)}" target="_blank" rel="noreferrer">보기</a>`;
}

function openImagePreview(url) {
  imagePreview.src = url;
  imagePreviewModal.classList.remove("hidden");
}

function closeImagePreview() {
  imagePreviewModal.classList.add("hidden");
  imagePreview.removeAttribute("src");
}

function fileToPayload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      name: file.name,
      type: file.type || "application/octet-stream",
      dataUrl: reader.result
    });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function createExportXlsx(items) {
  const rows = [
    ["이미지 URL", "분석 화면", "위험도", "확인필요", "보완점", "개선 이유", "개선체크리스트(법률상 위반 근거)", "업로드일자"],
    ...items.map((item) => [
      item.imageUrl ? new URL(item.imageUrl, location.origin).href : "",
      item.screenName || "",
      item.riskLevel || "",
      item.needsReview ? "Y" : "",
      item.fix || "",
      item.reason || "",
      item.checklist || "",
      formatDate(item.uploadedAt)
    ])
  ];
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Audit Export" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": sheetXml(rows),
    "xl/styles.xml": stylesXml()
  };
  return new Blob([zipStore(files)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function sheetXml(rows) {
  const widths = [38, 34, 12, 14, 76, 64, 52, 20];
  const cols = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
  const body = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}" ht="22" customHeight="1">${row.map((value, columnIndex) => {
    const style = rowIndex === 0 ? 1 : columnIndex === 2 && value === "위험" ? 3 : columnIndex === 2 && value === "보통" ? 4 : columnIndex === 2 && value === "낮음" ? 5 : 2;
    return `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr" s="${style}"><is><t>${xmlEscape(value)}</t></is></c>`;
  }).join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><color rgb="FF0064FF"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts><fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEAF3FF"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF0F0"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF7E6"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8F7EF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FFD1D6DB"/></left><right style="thin"><color rgb="FFD1D6DB"/></right><top style="thin"><color rgb="FFD1D6DB"/></top><bottom style="thin"><color rgb="FFD1D6DB"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" horizontal="center"/></xf><xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" horizontal="center"/></xf><xf numFmtId="0" fontId="2" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" horizontal="center"/></xf></cellXfs></styleSheet>`;
}

function zipStore(fileMap) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  Object.entries(fileMap).forEach(([filename, content]) => {
    const nameBytes = encoder.encode(filename);
    const contentBytes = typeof content === "string" ? encoder.encode(content) : content;
    const crc = crc32(contentBytes);
    const localHeader = zipHeader(0x04034b50, nameBytes, contentBytes, crc, offset);
    localParts.push(localHeader, contentBytes);
    centralParts.push(zipHeader(0x02014b50, nameBytes, contentBytes, crc, offset));
    offset += localHeader.length + contentBytes.length;
  });
  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, centralParts.length, true);
  view.setUint16(10, centralParts.length, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  return concatBytes([...localParts, ...centralParts, end]);
}

function zipHeader(signature, nameBytes, contentBytes, crc, offset) {
  const isCentral = signature === 0x02014b50;
  const bytes = new Uint8Array((isCentral ? 46 : 30) + nameBytes.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, signature, true);
  if (isCentral) {
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 2048, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, contentBytes.length, true);
    view.setUint32(24, contentBytes.length, true);
    view.setUint16(28, nameBytes.length, true);
    view.setUint32(42, offset, true);
    bytes.set(nameBytes, 46);
  } else {
    view.setUint16(4, 20, true);
    view.setUint16(6, 2048, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, contentBytes.length, true);
    view.setUint32(22, contentBytes.length, true);
    view.setUint16(26, nameBytes.length, true);
    bytes.set(nameBytes, 30);
  }
  return bytes;
}

function crc32(bytes) {
  let crc = -1;
  for (let index = 0; index < bytes.length; index += 1) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[index]) & 255];
  return (crc ^ -1) >>> 0;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function concatBytes(parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  parts.forEach((part) => {
    output.set(part, offset);
    offset += part.length;
  });
  return output;
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function columnName(index) {
  let name = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function xmlEscape(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function riskClass(value) {
  if (value === "위험") return "risk-high";
  if (value === "낮음") return "risk-low";
  return "risk-medium";
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

function setStatus(message) {
  statusText.textContent = message;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadItems().catch((error) => setStatus(error.message));
