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
const searchInput = document.getElementById("searchInput");
const sortSelect = document.getElementById("sortSelect");
const supabaseConfig = window.SUPABASE_CONFIG || {};
const supabaseBucket = supabaseConfig.bucket || "audit-files";
const supabaseClient = supabaseConfig.url && supabaseConfig.anonKey ? createSupabaseRestClient(supabaseConfig) : null;

let auditItems = [];
let activeFilter = "all";
let searchQuery = "";
let activeSort = "uploadedAt-desc";

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
    if (supabaseClient) {
      await supabaseClient.update("audit_items", { needs_review: checkbox.checked }, { id: item.id });
      if (activeFilter === "needsReview") renderItems(getVisibleItems());
      return;
    }
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
    if (supabaseClient) {
      await supabaseClient.remove("audit_items", { id: button.dataset.deleteItem });
      await loadItems();
      return;
    }
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
    if (supabaseClient) {
      for (const file of files) await createSupabaseAuditReport(file);
      fileInput.value = "";
      uploadModal.classList.add("hidden");
      await loadItems();
      return;
    }
    if (isGitHubPages()) throw new Error("Supabase 설정 파일이 아직 반영되지 않았습니다. audit.js와 supabase-config.js를 GitHub에 다시 업로드한 뒤 새로고침해 주세요.");
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
    fileInput.value = "";
    uploadModal.classList.add("hidden");
    await loadItems();
  } catch (error) {
    setStatus(error.message);
  }
}

async function loadItems() {
  if (supabaseClient) {
    const reports = await supabaseClient.select("audit_reports", { order: "created_at.desc" });
    const items = await supabaseClient.select("audit_items", { order: "uploaded_at.desc" });
    auditItems = (items || []).map((item) => {
      const report = (reports || []).find((entry) => entry.id === item.report_id);
      return auditItemFromSupabaseRow(item, report);
    });
    setStatus("Supabase에 저장된 최신 데이터를 불러왔습니다.");
    renderCounts();
    renderItems(getVisibleItems());
    return;
  }
  try {
    const response = await fetch("/api/audit-reports");
    if (!response.ok) throw new Error("API unavailable");
    const data = await response.json();
    auditItems = data.items || [];
  } catch {
    const response = await fetch("audit-data/reports.json");
    const data = await response.json();
    auditItems = normalizeAuditItems(data);
    setStatus("Supabase 설정 전에는 현재 업로드된 정적 데이터만 표시됩니다.");
  }
  renderCounts();
  renderItems(getVisibleItems());
}

function normalizeAuditItems(data) {
  const reports = Array.isArray(data) ? data : data.reports || [];
  const items = Array.isArray(data) ? reports.flatMap((report) => (report.items || []).map((item) => ({
    ...item,
    reportTitle: report.title,
    files: report.files || [],
    imageUrl: normalizeAssetUrl(item.imageUrl),
    sourceFileName: item.sourceFileName || report.files?.[0]?.name || report.title
  }))) : data.items || [];
  return items.map((item) => ({ ...item, imageUrl: normalizeAssetUrl(item.imageUrl) }));
}

function normalizeAssetUrl(url) {
  if (!url) return "";
  if (/^https?:/i.test(url) || url.startsWith("data:")) return url;
  return url.replace(/^\/audit-files\//, "audit-data/uploads/").replace(/^\//, "");
}

async function createSupabaseAuditReport(file) {
  const reportId = auditId();
  const createdAt = new Date().toISOString();
  const originalName = cleanFileName(file.name || "attachment.bin");
  const storageName = storageFileName(originalName);
  const filePath = `${reportId}/${storageName}`;
  await supabaseClient.upload(supabaseBucket, filePath, file, file.type || contentTypeFromName(originalName));
  const fileUrl = publicSupabaseFileUrl(filePath);
  const savedFile = {
    name: originalName,
    type: file.type || contentTypeFromName(originalName),
    size: file.size || 0,
    url: fileUrl
  };
  const extractedItems = await extractAuditItemsFromBrowserFile(file, reportId);
  const firstItem = extractedItems[0] || {};
  const report = {
    id: reportId,
    title: cleanText(firstItem.screenName || originalName.replace(/\.[^.]+$/, "") || "다크패턴 검사 보고서"),
    risk_level: normalizeAuditRisk(firstItem.riskLevel || "보통"),
    description: "",
    owner: "",
    status: "검토 전",
    created_at: createdAt,
    files: [savedFile]
  };
  await supabaseClient.insert("audit_reports", report);
  const rows = extractedItems.length
    ? extractedItems.map((item, index) => supabaseItemRow({
      ...item,
      id: `${reportId}-${index + 1}`,
      reportId,
      imageUrl: item.imageUrl || fileUrl,
      sourceFileName: originalName,
      uploadedAt: createdAt
    }, index))
    : [supabaseItemRow({
      id: `${reportId}-1`,
      reportId,
      imageUrl: /^image\//.test(savedFile.type) ? fileUrl : "",
      screenName: originalName.replace(/\.[^.]+$/, ""),
      riskLevel: "보통",
      fix: "",
      reason: "",
      checklist: "",
      area: "",
      sourceFileName: originalName,
      uploadedAt: createdAt
    }, 0)];
  await supabaseClient.insert("audit_items", rows);
}

async function extractAuditItemsFromBrowserFile(file, reportId) {
  try {
    if (/\.xlsx$/i.test(file.name)) return await extractAuditItemsFromBrowserXlsx(await file.arrayBuffer(), file, reportId);
    if (/\.html?$/i.test(file.name)) return extractAuditItemsFromHtml(await file.text(), file);
    if (/^image\//.test(file.type)) {
      return [{
        imageUrl: "",
        screenName: file.name.replace(/\.[^.]+$/, ""),
        riskLevel: "보통",
        fix: "",
        reason: "",
        checklist: "",
        area: "",
        sourceFileName: file.name
      }];
    }
  } catch (error) {
    setStatus(`파일 파싱 실패: ${error.message}`);
  }
  return [];
}

async function extractAuditItemsFromBrowserXlsx(arrayBuffer, file, reportId) {
  const entries = await unzipEntries(arrayBuffer);
  const sheetXml = await entryText(entries.get("xl/worksheets/sheet1.xml"));
  if (!sheetXml) return [];
  const sharedStrings = await parseSharedStrings(entries.get("xl/sharedStrings.xml"));
  const rows = parseXlsxRows(sheetXml, sharedStrings);
  if (!rows.length) return [];
  const headerIndex = rows.findIndex((row) => row.some((cell) => /위험도/.test(cell)) && row.some((cell) => /보완점/.test(cell)));
  if (headerIndex === -1) return [];
  const headers = rows[headerIndex].map((cell) => cell.trim());
  const imageFile = [...entries.keys()].find((name) => /^xl\/media\/image\d+\.(png|jpg|jpeg)$/i.test(name));
  let imageUrl = "";
  if (imageFile) {
    const imageBytes = entries.get(imageFile);
    const imageName = embeddedImageName(file.name, imageFile);
    const imagePath = `${reportId}/${imageName}`;
    await supabaseClient.upload(supabaseBucket, imagePath, new Blob([imageBytes], { type: contentTypeFromName(imageName) }), contentTypeFromName(imageName));
    imageUrl = publicSupabaseFileUrl(imagePath);
  }
  return rows.slice(headerIndex + 1)
    .filter((row) => row.some(Boolean))
    .map((row) => ({ ...auditItemFromCells(headers, row, imageUrl), sourceFileName: file.name }));
}

function auditItemFromSupabaseRow(item, report = {}) {
  return {
    id: item.id,
    reportId: item.report_id,
    imageUrl: item.image_url || "",
    screenName: item.screen_name || "",
    riskLevel: item.risk_level || "보통",
    fix: item.fix || "",
    reason: item.reason || "",
    checklist: item.checklist || "",
    area: item.area || "",
    sourceFileName: item.source_file_name || "",
    needsReview: Boolean(item.needs_review),
    uploadedAt: item.uploaded_at || "",
    reportTitle: report?.title || "",
    files: Array.isArray(report?.files) ? report.files : []
  };
}

function supabaseItemRow(item, index) {
  return {
    id: item.id,
    report_id: item.reportId,
    sort_index: index,
    image_url: item.imageUrl || "",
    screen_name: cleanText(item.screenName || ""),
    risk_level: normalizeAuditRisk(item.riskLevel || "보통"),
    fix: cleanText(item.fix || ""),
    reason: cleanText(item.reason || ""),
    checklist: cleanText(item.checklist || ""),
    area: cleanText(item.area || ""),
    source_file_name: cleanText(item.sourceFileName || ""),
    needs_review: Boolean(item.needsReview),
    uploaded_at: item.uploadedAt
  };
}

function renderItems(items) {
  renderCounts();
  const label = searchQuery ? `${filterLabel(activeFilter)} 검색결과` : filterLabel(activeFilter);
  tableTitle.innerHTML = `${escapeHtml(label)} <span id="tableCount">${items.length}</span>`;
  emptyBox.textContent = auditItems.length ? "조건에 맞는 검수건이 없습니다." : "아직 업로드된 검수건이 없습니다.";
  emptyBox.classList.toggle("hidden", items.length > 0);
  itemBody.innerHTML = items.map((item) => `
    <article class="audit-item">
      <div class="audit-media">${imageCell(item.imageUrl)}</div>
      <div class="audit-main">
        <div class="audit-head">
          <div class="audit-title-group">
            <h3>${escapeHtml(item.screenName || "-")}</h3>
          </div>
          <div class="audit-meta">
            <span class="badge ${riskClass(item.riskLevel)}">${escapeHtml(item.riskLevel || "보통")}</span>
            ${reviewCheckbox(item)}
            <span class="date-chip">${formatDate(item.uploadedAt)}</span>
          </div>
        </div>
        <div class="audit-summary">
          <section>
            <span>보완점</span>
            <p>${escapeHtml(item.fix || "-")}</p>
          </section>
          <section>
            <span>개선 이유</span>
            <p>${escapeHtml(item.reason || "-")}</p>
          </section>
          <section>
            <span>근거</span>
            <p>${escapeHtml(item.checklist || "-")}</p>
          </section>
        </div>
      </div>
      <div class="audit-actions">
        <button class="delete-button" type="button" data-delete-item="${escapeHtml(item.id)}">삭제</button>
      </div>
    </article>
  `).join("");
}

function renderCounts() {
  totalCount.textContent = auditItems.length;
  highCount.textContent = auditItems.filter((item) => item.riskLevel === "위험").length;
  mediumCount.textContent = auditItems.filter((item) => item.riskLevel === "보통").length;
  lowCount.textContent = auditItems.filter((item) => item.riskLevel === "낮음").length;
  needsReviewCount.textContent = auditItems.filter((item) => item.needsReview).length;
}

function getFilteredItems() {
  if (activeFilter === "all") return auditItems;
  if (activeFilter === "needsReview") return auditItems.filter((item) => item.needsReview);
  return auditItems.filter((item) => item.riskLevel === activeFilter);
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
  const absoluteUrl = new URL(url, location.href).href;
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

function extractAuditItemsFromHtml(htmlText, file) {
  const rows = [...htmlText.matchAll(/<tr[\s\S]*?<\/tr>/gi)]
    .map((match) => [...match[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => stripHtml(cell[1])));
  const headerIndex = rows.findIndex((row) => row.some((cell) => /위험도/.test(cell)) && row.some((cell) => /보완점/.test(cell)));
  if (headerIndex === -1) return [];
  const headers = rows[headerIndex];
  return rows.slice(headerIndex + 1)
    .filter((row) => row.some(Boolean))
    .map((row) => ({ ...auditItemFromCells(headers, row, ""), sourceFileName: file.name }));
}

function auditItemFromCells(headers, row, fallbackImageUrl) {
  const value = (namePattern) => {
    const index = headers.findIndex((header) => namePattern.test(header));
    return index >= 0 ? cleanText(row[index] || "") : "";
  };
  const imageValue = value(/이미지|화면 이미지|URL/i);
  const validImageUrl = /^\/|^https?:|^data:image/.test(imageValue) && !/^embedded:/.test(imageValue) ? imageValue : fallbackImageUrl;
  return {
    imageUrl: validImageUrl,
    screenName: value(/분석 화면|화면명|프레임/i),
    riskLevel: normalizeAuditRisk(value(/위험도|위험수준/i)),
    fix: value(/보완점|개선안/i),
    reason: value(/개선 이유|사유/i),
    checklist: value(/체크리스트|근거/i),
    area: value(/개선영역|영역/i)
  };
}

async function unzipEntries(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const entries = new Map();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset < bytes.length - 4) {
    if (readUint32(bytes, offset) !== 0x04034b50) break;
    const method = readUint16(bytes, offset + 8);
    const compressedSize = readUint32(bytes, offset + 18);
    const uncompressedSize = readUint32(bytes, offset + 22);
    const nameLength = readUint16(bytes, offset + 26);
    const extraLength = readUint16(bytes, offset + 28);
    const name = decoder.decode(bytes.slice(offset + 30, offset + 30 + nameLength));
    const dataStart = offset + 30 + nameLength + extraLength;
    const compressed = bytes.slice(dataStart, dataStart + compressedSize);
    let data = new Uint8Array();
    if (method === 0) data = compressed;
    if (method === 8) data = await inflateRaw(compressed);
    if (data.length || uncompressedSize === 0) entries.set(name, data);
    offset = dataStart + compressedSize;
  }
  return entries;
}

async function inflateRaw(bytes) {
  if (!("DecompressionStream" in window)) throw new Error("이 브라우저는 XLSX 압축 해제를 지원하지 않습니다.");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parseXlsxRows(xml, sharedStrings = []) {
  return [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((rowMatch) =>
    [...rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)].reduce((cells, cellMatch) => {
      const attrs = cellMatch[1] || "";
      const body = cellMatch[2] || "";
      const ref = attrs.match(/\br="([A-Z]+)\d+"/);
      const col = ref ? columnIndex(ref[1]) : cells.length;
      const isShared = /\bt="s"/.test(attrs);
      const valueMatch = body.match(/<v[^>]*>([\s\S]*?)<\/v>/);
      const inlineText = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => xmlUnescape(match[1])).join("");
      const value = isShared && valueMatch ? sharedStrings[Number(valueMatch[1])] || "" : inlineText || xmlUnescape(valueMatch?.[1] || "");
      cells[col] = cleanText(value);
      return cells;
    }, [])
  );
}

async function parseSharedStrings(entry) {
  const xml = await entryText(entry);
  if (!xml) return [];
  return [...xml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)]
    .map((match) => [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((item) => xmlUnescape(item[1])).join(""));
}

async function entryText(entry) {
  if (!entry) return "";
  return new TextDecoder().decode(entry);
}

function readUint16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function embeddedImageName(fileName, imageFile) {
  const ext = imageFile.match(/\.[^.]+$/)?.[0] || ".png";
  const base = storageFileName(fileName).replace(/\.[^.]+$/, "");
  const imageBase = imageFile.split("/").pop().replace(/\.[^.]+$/, "");
  return storageFileName(`${base}-${imageBase}${ext}`);
}

function stripHtml(value) {
  return cleanText(String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'"));
}

function createExportXlsx(items) {
  const rows = [
    ["이미지 URL", "분석 화면", "위험도", "확인필요", "보완점", "개선 이유", "개선체크리스트(법률상 위반 근거)", "업로드일자"],
    ...items.map((item) => [
      item.imageUrl ? new URL(item.imageUrl, location.href).href : "",
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

function columnIndex(name) {
  return String(name || "").split("").reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function xmlEscape(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function riskClass(value) {
  if (value === "위험") return "risk-high";
  if (value === "낮음") return "risk-low";
  return "risk-medium";
}

function normalizeAuditRisk(value) {
  if (/위험|높음|high/i.test(String(value))) return "위험";
  if (/낮음|low/i.test(String(value))) return "낮음";
  return "보통";
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function safeFileName(value) {
  const filename = String(value || "attachment.bin").split("/").pop();
  const ext = filename.match(/\.[^.]+$/)?.[0]?.slice(0, 12) || "";
  const base = filename.slice(0, ext ? -ext.length : filename.length)
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "attachment";
  return `${base}${ext}`;
}

function cleanFileName(value) {
  return safeFileName(value || "attachment.bin");
}

function storageFileName(value) {
  const filename = String(value || "attachment.bin").split("/").pop();
  const ext = filename.match(/\.[^.]+$/)?.[0]?.slice(0, 12).toLowerCase() || "";
  const base = filename.slice(0, ext ? -ext.length : filename.length)
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/[_-]+$/g, "")
    .replace(/^[_-]+/g, "")
    .slice(0, 80) || "attachment";
  return `${base}${ext}`;
}

function contentTypeFromName(name) {
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.xlsx$/i.test(name)) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (/\.html?$/i.test(name)) return "text/html";
  return "application/octet-stream";
}

function publicSupabaseFileUrl(path) {
  return supabaseClient.publicUrl(supabaseBucket, path);
}

function auditId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createSupabaseRestClient(config) {
  const baseUrl = String(config.url || "").replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "");
  const headers = {
    apikey: config.anonKey,
    Authorization: `Bearer ${config.anonKey}`
  };
  const jsonHeaders = {
    ...headers,
    "Content-Type": "application/json",
    Prefer: "return=representation"
  };

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, options);
    const text = await response.text();
    const payload = text ? safeJsonParse(text) : null;
    if (!response.ok) {
      const message = payload?.message || payload?.error || payload?.hint || `Supabase HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload;
  }

  function filterQuery(filters = {}) {
    return Object.entries(filters)
      .map(([key, value]) => `${encodeURIComponent(key)}=eq.${encodeURIComponent(value)}`)
      .join("&");
  }

  return {
    select(table, { order = "" } = {}) {
      const params = new URLSearchParams({ select: "*" });
      if (order) params.set("order", order);
      return request(`/rest/v1/${table}?${params}`, { headers });
    },
    insert(table, rows) {
      return request(`/rest/v1/${table}`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify(rows)
      });
    },
    update(table, updates, filters) {
      return request(`/rest/v1/${table}?${filterQuery(filters)}`, {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify(updates)
      });
    },
    remove(table, filters) {
      return request(`/rest/v1/${table}?${filterQuery(filters)}`, {
        method: "DELETE",
        headers: { ...headers, Prefer: "return=representation" }
      });
    },
    async upload(bucket, path, body, contentTypeValue) {
      const response = await fetch(`${baseUrl}/storage/v1/object/${bucket}/${encodePath(path)}`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": contentTypeValue || "application/octet-stream",
          "x-upsert": "true"
        },
        body
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || payload.error || `Storage upload HTTP ${response.status}`);
      }
      return response.json().catch(() => ({}));
    },
    publicUrl(bucket, path) {
      return `${baseUrl}/storage/v1/object/public/${bucket}/${encodePath(path)}`;
    }
  };
}

function encodePath(path) {
  return String(path || "").split("/").map(encodeURIComponent).join("/");
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return { message: value.slice(0, 180) };
  }
}

function isGitHubPages() {
  return location.hostname.endsWith("github.io");
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
