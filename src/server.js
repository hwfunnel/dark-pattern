import http from "node:http";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const auditDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, "audit-data");
const auditUploadDir = path.join(auditDir, "uploads");
const auditDbFile = path.join(auditDir, "reports.json");

loadEnvFile(path.join(rootDir, ".env"));

const PORT = Number(process.env.PORT || 5177);
const HOST = process.env.HOST || "localhost";
const DATASET_URL = "https://datasets-server.huggingface.co/rows";
const DATASET_NAME = "nvidia/Nemotron-Personas-Korea";
const GEMINI_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-flash-latest"
];
const GEMINI_RETRYABLE_STATUSES = new Set([400, 404, 408, 429, 500, 502, 503, 504]);
const DATASET_FETCH_TIMEOUT_MS = Number(process.env.DATASET_FETCH_TIMEOUT_MS || 2500);
const GEMINI_FETCH_TIMEOUT_MS = Number(process.env.GEMINI_FETCH_TIMEOUT_MS || 60000);
const POSTGRES_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_PRISMA_URL || "";
const DARK_PATTERN_SOURCES = [
  {
    name: "공정거래위원회 온라인 다크패턴 자율관리 가이드라인",
    url: "https://www.ftc.go.kr/",
    usedFor: "전자상거래·온라인 화면의 오인 유도, 숨은 정보, 반복 압박, 취소 방해 등 검토 기준"
  },
  {
    name: "전자상거래 등에서의 소비자보호에 관한 법률",
    url: "https://www.law.go.kr/법령/전자상거래등에서의소비자보호에관한법률",
    usedFor: "온라인 거래 과정의 소비자 선택권, 중요 정보 고지, 기만적 표시 검토"
  },
  {
    name: "금융소비자 보호에 관한 법률",
    url: "https://www.law.go.kr/법령/금융소비자보호에관한법률",
    usedFor: "금융상품 설명의무, 중요사항 고지, 오인 가능 표현 검토"
  }
];

let candidateCache = [];
let cacheAt = 0;
let candidateSource = "huggingface";
let postgresSql = null;
let blobPut = null;

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (req.method === "OPTIONS") {
      return sendJson(res, 204, {});
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      return sendJson(res, 200, {
        dataset: DATASET_NAME,
        aiProvider: process.env.GEMINI_API_KEY ? "gemini" : "fallback",
        keyLoaded: Boolean(process.env.GEMINI_API_KEY),
        cachedCandidates: candidateCache.length,
        candidateSource
      });
    }

    if (req.method === "GET" && url.pathname === "/api/audit-reports") {
      const reports = await listAuditReports();
      return sendJson(res, 200, { reports, items: flattenAuditItems(reports) });
    }

    if (req.method === "GET" && url.pathname === "/api/audit-history") {
      const history = await listAuditHistory();
      return sendJson(res, 200, { history });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/audit-reports/")) {
      const id = path.basename(url.pathname);
      const report = (await listAuditReports()).find((item) => item.id === id);
      return report ? sendJson(res, 200, { report }) : sendJson(res, 404, { error: "report not found" });
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/audit-items/")) {
      const id = decodeURIComponent(path.basename(url.pathname));
      const body = await readJson(req);
      const result = await updateAuditItem(id, body);
      return result.updated ? sendJson(res, 200, result) : sendJson(res, 404, { error: "item not found" });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/audit-items/")) {
      const id = decodeURIComponent(path.basename(url.pathname));
      const result = await deleteAuditItem(id);
      return result.deleted ? sendJson(res, 200, result) : sendJson(res, 404, { error: "item not found" });
    }

    if (req.method === "POST" && url.pathname === "/api/audit-reports") {
      const body = await readJson(req, 25 * 1024 * 1024);
      const report = await createAuditReport(body);
      return sendJson(res, 201, { report });
    }

    if (req.method === "GET" && url.pathname.startsWith("/audit-files/")) {
      return serveAuditFile(url.pathname, res);
    }

    if (req.method === "POST" && url.pathname === "/api/research") {
      const body = await readJson(req);
      const target = cleanText(body.target || "");
      const question = cleanText(body.question || "");
      if (!target || !question) {
        return sendJson(res, 400, { error: "target and question are required" });
      }

      const rows = await loadNemotronCandidates(target);
      const ranked = rankCandidates(rows, target);
      const selected = diversifyCandidates(ranked, 5);
      const fallback = buildFallbackResearch(target, question, selected, rows.length);

      if (!process.env.GEMINI_API_KEY) {
        return sendJson(res, 200, {
          ...fallback,
          aiMode: "fallback",
          notice: "GEMINI_API_KEY가 없어 규칙 기반 인터뷰 엔진으로 생성했습니다."
        });
      }

      try {
        const aiResult = await callGemini(target, question, selected, fallback);
        return sendJson(res, 200, { ...aiResult, aiMode: "gemini" });
      } catch (error) {
        return sendJson(res, 503, {
          error: `AI 분석에 실패했습니다. 잠시 후 다시 실행해 주세요: ${error.message}`,
          aiMode: "error"
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/figma-feedback") {
      const body = await readJson(req);
      const frameName = cleanText(body.frameName || "선택 프레임");
      const screenDescription = cleanText(body.screenDescription || "");
      const target = cleanText(body.target || "한국 일반 사용자");
      const analysisMode = normalizeAnalysisMode(body.analysisMode || "single");
      const framesMeta = Array.isArray(body.framesMeta) ? body.framesMeta.slice(0, 6) : [];
      const textLayers = normalizeTextLayers(body.textLayers);
      const imageDataUrl = typeof body.imageDataUrl === "string" ? body.imageDataUrl : "";
      const imageDataUrls = Array.isArray(body.imageDataUrls) ? body.imageDataUrls.slice(0, 6).filter((item) => typeof item === "string") : [];
      const allowFeedbackImages = process.env.FIGMA_FEEDBACK_USE_IMAGES !== "0";

      if (!screenDescription) {
        return sendJson(res, 400, { error: "screenDescription is required" });
      }

      const analysisContext = `${target} ${screenDescription} ${textLayers.map((layer) => layer.text).join(" ")}`;
      const rows = await loadNemotronCandidates(analysisContext);
      const ranked = rankCandidates(rows, analysisContext);
      const selected = diversifyCandidates(ranked, 5);
      const fallback = buildFallbackFigmaFeedback({
        frameName,
        screenDescription,
        target,
        analysisMode,
        framesMeta,
        selected,
        poolSize: rows.length
      });

      if (!process.env.GEMINI_API_KEY) {
        return sendJson(res, 200, {
          ...fallback,
          aiMode: "fallback",
          notice: "GEMINI_API_KEY가 없어 규칙 기반 디자인 피드백을 반환했습니다."
        });
      }

      try {
        const aiResult = await callGeminiFigmaFeedback({
          frameName,
          screenDescription,
          target,
          analysisMode,
          framesMeta,
          textLayers,
          imageDataUrls: allowFeedbackImages ? (imageDataUrls.length ? imageDataUrls : [imageDataUrl].filter(Boolean)) : [],
          selected,
          fallback
        });
        return sendJson(res, 200, { ...aiResult, aiMode: "gemini" });
      } catch (error) {
        return sendJson(res, 200, {
          ...fallback,
          aiMode: "fallback",
          notice: `Gemini 호출 실패로 규칙 기반 결과를 반환했습니다: ${error.message}`
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/describe-frame") {
      const body = await readJson(req);
      const frameName = cleanText(body.frameName || "선택 프레임");
      const imageDataUrl = typeof body.imageDataUrl === "string" ? body.imageDataUrl : "";
      const textLayers = normalizeTextLayers(body.textLayers);
      const fallback = buildFallbackFrameDescription(frameName, textLayers);

      if (!process.env.GEMINI_API_KEY) {
        return sendJson(res, 200, {
          description: fallback,
          aiMode: "fallback",
          notice: "GEMINI_API_KEY가 없어 텍스트 레이어 기반 설명을 넣었습니다."
        });
      }

      try {
        const description = await callGeminiFrameDescription({ frameName, imageDataUrl, textLayers, fallback });
        return sendJson(res, 200, { description, aiMode: "gemini" });
      } catch (error) {
        return sendJson(res, 200, {
          description: fallback,
          aiMode: "fallback",
          notice: `Gemini 설명 생성 실패로 텍스트 레이어 기반 설명을 넣었습니다: ${error.message}`
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/dark-pattern-check") {
      const body = await readJson(req);
      const frameName = cleanText(body.frameName || "선택 프레임");
      const frameMeta = body.frameMeta && typeof body.frameMeta === "object" ? body.frameMeta : {};
      const screenDescription = cleanText(body.screenDescription || "");
      const businessContext = cleanText(body.businessContext || "");
      const imageDataUrl = typeof body.imageDataUrl === "string" ? body.imageDataUrl : "";
      const textLayers = normalizeTextLayers(body.textLayers);

      if (!screenDescription && !businessContext) {
        return sendJson(res, 400, { error: "screenDescription or businessContext is required" });
      }

      const analysisContext = `${frameName} ${screenDescription} ${businessContext} ${textLayers.map((layer) => layer.text).join(" ")}`;
      const rows = await loadNemotronCandidates(analysisContext);
      const ranked = rankCandidates(rows, analysisContext);
      const selected = diversifyCandidates(ranked, 8);
      const fallback = buildFallbackDarkPatternCheck({
        frameName,
        frameMeta,
        screenDescription,
        businessContext,
        textLayers,
        selected,
        poolSize: rows.length
      });

      if (!process.env.GEMINI_API_KEY) {
        return sendJson(res, 200, {
          ...fallback,
          aiMode: "fallback",
          notice: "GEMINI_API_KEY가 없어 규칙 기반 다크패턴 검토 결과를 반환했습니다."
        });
      }

      try {
        const aiResult = await callGeminiDarkPatternCheck({
          frameName,
          frameMeta,
          screenDescription,
          businessContext,
          textLayers,
          imageDataUrl,
          selected,
          fallback
        });
        return sendJson(res, 200, { ...aiResult, aiMode: "gemini" });
      } catch (error) {
        return sendJson(res, 200, {
          ...fallback,
          aiMode: "fallback",
          notice: `Gemini 호출 실패로 규칙 기반 결과를 반환했습니다: ${error.message}`
        });
      }
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    sendJson(res, 405, { error: "method not allowed" });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "internal server error" });
  }
}

if (!process.env.VERCEL) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, HOST, () => {
    console.log(`Nemotron Korea Persona Research running at http://${HOST}:${PORT}`);
    console.log(`AI mode: ${process.env.GEMINI_API_KEY ? "Gemini server-side key loaded" : "fallback engine"}`);
  });
}

export default handleRequest;

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

async function readJson(req, maxBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

function shouldTryNextGeminiModel(status) {
  return GEMINI_RETRYABLE_STATUSES.has(status);
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  } catch (error) {
    if (error && error.name === "AbortError") {
      return {
        response: { ok: false, status: 408 },
        payload: { error: { message: `timeout after ${Math.round(timeoutMs / 1000)}s` } }
      };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGeminiGenerateContent(model, body) {
  return fetchJsonWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY
    },
    body: JSON.stringify(body)
  }, GEMINI_FETCH_TIMEOUT_MS);
}

async function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (filePath.endsWith(".csv")) return "text/csv; charset=utf-8";
  if (filePath.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

async function serveAuditFile(pathname, res) {
  const relativePath = decodeURIComponent(pathname.replace(/^\/audit-files\//, ""));
  const filePath = path.normalize(path.join(auditUploadDir, relativePath));
  if (!filePath.startsWith(auditUploadDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "private, max-age=3600"
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function ensureAuditStore() {
  await mkdir(auditUploadDir, { recursive: true });
  if (isVercelStorageEnabled()) {
    await ensurePostgresSchema();
    return;
  }
  if (!existsSync(auditDbFile)) await writeFile(auditDbFile, "[]", "utf8");
}

async function listAuditReports() {
  await ensureAuditStore();
  if (isVercelStorageEnabled()) return listPostgresAuditReports();
  try {
    const reports = JSON.parse(await readFile(auditDbFile, "utf8"));
    return Array.isArray(reports) ? reports.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) : [];
  } catch {
    return [];
  }
}

async function updateAuditItem(id, updates) {
  const reports = await listAuditReports();
  const existing = flattenAuditItems(reports).find((item) => item.id === id);
  if (!existing) return { updated: false };
  const needsReview = Boolean(updates.needsReview);
  const updatedItem = { ...existing, needsReview };
  if (isVercelStorageEnabled()) {
    const sql = await getPostgresSql();
    await sql`update audit_items set needs_review = ${needsReview} where id = ${id}`;
  } else {
    await saveAuditReports(reports.map((report) => ({
      ...report,
      items: (report.items || []).map((item) => item.id === id ? updatedItem : item)
    })));
  }
  await recordAuditEvent("item.updated", {
    reportId: updatedItem.reportId,
    itemId: updatedItem.id,
    snapshot: { needsReview }
  });
  return { updated: true, item: updatedItem };
}

async function deleteAuditItem(id) {
  const reports = await listAuditReports();
  const deletedItem = flattenAuditItems(reports).find((item) => item.id === id);
  if (!deletedItem) return { deleted: false };
  if (isVercelStorageEnabled()) {
    const sql = await getPostgresSql();
    await sql`delete from audit_items where id = ${id}`;
  }
  await recordAuditEvent("item.deleted", {
    reportId: deletedItem.reportId,
    itemId: deletedItem.id,
    snapshot: deletedItem
  });
  const nextReports = reports.map((report) => ({
    ...report,
    items: (report.items || []).filter((item) => item.id !== id)
  })).filter((report) => (report.items || []).length);
  const deletedReportStillExists = nextReports.some((report) => report.id === deletedItem.reportId);
  if (isVercelStorageEnabled()) {
    if (!deletedReportStillExists && deletedItem.reportId) {
      const sql = await getPostgresSql();
      await sql`delete from audit_reports where id = ${deletedItem.reportId}`;
    }
  } else {
    await saveAuditReports(nextReports);
  }
  if (!deletedReportStillExists && deletedItem.reportId) {
    await recordAuditEvent("report.deleted", {
      reportId: deletedItem.reportId,
      snapshot: { reason: "last item deleted" }
    });
    if (!isVercelStorageEnabled()) await rm(path.join(auditUploadDir, deletedItem.reportId), { recursive: true, force: true });
  }
  return { deleted: true, id };
}

async function createAuditReport(body) {
  await ensureAuditStore();
  const id = auditId();
  const files = Array.isArray(body.files) ? body.files.slice(0, 8) : [];
  const reportDir = path.join(auditUploadDir, id);
  if (!isVercelStorageEnabled()) await mkdir(reportDir, { recursive: true });
  const savedFiles = [];
  const extractedItems = [];

  for (const file of files) {
    const saved = await saveAuditUploadFile(id, reportDir, file);
    if (saved) {
      extractedItems.push(...await extractAuditItemsFromFile(saved, id));
      const { path: _path, buffer: _buffer, ...publicFile } = saved;
      savedFiles.push(publicFile);
    }
  }

  const firstItem = extractedItems[0] || {};
  const createdAt = new Date().toISOString();
  const report = {
    id,
    title: cleanText(body.title || firstItem.screenName || savedFiles[0]?.name || "다크패턴 검사 보고서"),
    riskLevel: normalizeAuditRisk(body.riskLevel || firstItem.riskLevel || "보통"),
    description: cleanText(body.description || ""),
    owner: cleanText(body.owner || ""),
    status: cleanText(body.status || "검토 전"),
    createdAt,
    files: savedFiles,
    items: extractedItems.length ? extractedItems.map((item, index) => ({
      id: `${id}-${index + 1}`,
      reportId: id,
      imageUrl: item.imageUrl || savedFiles.find((file) => /^image\//.test(file.type))?.url || "",
      screenName: cleanText(item.screenName || firstItem.screenName || path.basename(savedFiles[0]?.name || "", path.extname(savedFiles[0]?.name || ""))),
      riskLevel: normalizeAuditRisk(item.riskLevel || firstItem.riskLevel || "보통"),
      fix: cleanText(item.fix || ""),
      reason: cleanText(item.reason || ""),
      checklist: cleanText(item.checklist || ""),
      area: cleanText(item.area || ""),
      sourceFileName: cleanText(item.sourceFileName || savedFiles[0]?.name || ""),
      needsReview: Boolean(item.needsReview),
      uploadedAt: createdAt
    })) : savedFiles.map((file, index) => ({
      id: `${id}-${index + 1}`,
      reportId: id,
      imageUrl: /^image\//.test(file.type) ? file.url : "",
      screenName: path.basename(file.name, path.extname(file.name)),
      riskLevel: normalizeAuditRisk(body.riskLevel || "보통"),
      fix: "",
      reason: "",
      checklist: "",
      area: "",
      sourceFileName: file.name,
      needsReview: false,
      uploadedAt: createdAt
    }))
  };
  await insertAuditReport(report);
  await recordAuditEvent("report.created", {
    reportId: report.id,
    snapshot: {
      title: report.title,
      itemCount: report.items.length,
      files: report.files.map((file) => file.name)
    }
  });
  return report;
}

async function insertAuditReport(report) {
  if (isVercelStorageEnabled()) {
    const sql = await getPostgresSql();
    const reportRow = postgresReportRow(report);
    await sql`
      insert into audit_reports (id, title, risk_level, description, owner, status, created_at, files)
      values (${reportRow.id}, ${reportRow.title}, ${reportRow.risk_level}, ${reportRow.description}, ${reportRow.owner}, ${reportRow.status}, ${reportRow.created_at}, ${JSON.stringify(reportRow.files)}::jsonb)
      on conflict (id) do update set
        title = excluded.title,
        risk_level = excluded.risk_level,
        description = excluded.description,
        owner = excluded.owner,
        status = excluded.status,
        created_at = excluded.created_at,
        files = excluded.files
    `;
    if (report.items.length) {
      for (const [index, item] of report.items.entries()) {
        const row = postgresItemRow(item, index);
        await sql`
          insert into audit_items (id, report_id, sort_index, image_url, screen_name, risk_level, fix, reason, checklist, area, source_file_name, needs_review, uploaded_at)
          values (${row.id}, ${row.report_id}, ${row.sort_index}, ${row.image_url}, ${row.screen_name}, ${row.risk_level}, ${row.fix}, ${row.reason}, ${row.checklist}, ${row.area}, ${row.source_file_name}, ${row.needs_review}, ${row.uploaded_at})
          on conflict (id) do update set
            report_id = excluded.report_id,
            sort_index = excluded.sort_index,
            image_url = excluded.image_url,
            screen_name = excluded.screen_name,
            risk_level = excluded.risk_level,
            fix = excluded.fix,
            reason = excluded.reason,
            checklist = excluded.checklist,
            area = excluded.area,
            source_file_name = excluded.source_file_name,
            needs_review = excluded.needs_review,
            uploaded_at = excluded.uploaded_at
        `;
      }
    }
    return;
  }
  const reports = await listAuditReports();
  reports.unshift(report);
  await saveAuditReports(reports);
}

async function listAuditHistory(limit = 200) {
  await ensureAuditStore();
  if (!isVercelStorageEnabled()) return [];
  const sql = await getPostgresSql();
  const rows = await sql`
    select action, report_id, item_id, snapshot, created_at
    from audit_history
    order by created_at desc, id desc
    limit ${limit}
  `;
  return rows.map(postgresHistoryFromRow);
}

async function recordAuditEvent(action, { reportId = "", itemId = "", snapshot = {} } = {}) {
  if (!isVercelStorageEnabled()) return;
  const sql = await getPostgresSql();
  await sql`
    insert into audit_history (action, report_id, item_id, snapshot, created_at)
    values (${action}, ${reportId || null}, ${itemId || null}, ${JSON.stringify(snapshot)}::jsonb, ${new Date().toISOString()})
  `;
}

async function saveAuditReports(reports) {
  await ensureAuditStore();
  await writeFile(auditDbFile, JSON.stringify(reports, null, 2), "utf8");
}

function isVercelStorageEnabled() {
  return Boolean(POSTGRES_URL && (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID || process.env.VERCEL));
}

async function getPostgresSql() {
  if (postgresSql) return postgresSql;
  const { neon } = await import("@neondatabase/serverless");
  postgresSql = neon(POSTGRES_URL);
  return postgresSql;
}

async function getBlobPut() {
  if (blobPut) return blobPut;
  const blob = await import("@vercel/blob");
  blobPut = blob.put;
  return blobPut;
}

async function ensurePostgresSchema() {
  const sql = await getPostgresSql();
  await sql`
    create table if not exists audit_reports (
      id text primary key,
      title text not null,
      risk_level text not null default '보통',
      description text not null default '',
      owner text not null default '',
      status text not null default '검토 전',
      created_at timestamptz not null default now(),
      files jsonb not null default '[]'::jsonb
    )
  `;
  await sql`
    create table if not exists audit_items (
      id text primary key,
      report_id text not null references audit_reports(id) on delete cascade,
      sort_index integer not null default 0,
      image_url text not null default '',
      screen_name text not null default '',
      risk_level text not null default '보통',
      fix text not null default '',
      reason text not null default '',
      checklist text not null default '',
      area text not null default '',
      source_file_name text not null default '',
      needs_review boolean not null default false,
      uploaded_at timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists audit_history (
      id bigserial primary key,
      action text not null,
      report_id text,
      item_id text,
      snapshot jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )
  `;
}

async function listPostgresAuditReports() {
  const sql = await getPostgresSql();
  const reports = await sql`
    select id, title, risk_level, description, owner, status, created_at, files
    from audit_reports
    order by created_at desc
  `;
  const items = await sql`
    select *
    from audit_items
    order by report_id asc, sort_index asc, id asc
  `;
  const itemsByReport = new Map();
  reports.forEach((report) => itemsByReport.set(report.id, []));
  items.forEach((item) => {
    const reportItems = itemsByReport.get(item.report_id);
    if (reportItems) reportItems.push(auditItemFromPostgresRow(item));
  });
  return reports.map((report) => ({
    id: report.id,
    title: report.title,
    riskLevel: report.risk_level,
    description: report.description || "",
    owner: report.owner || "",
    status: report.status || "검토 전",
    createdAt: dateToIso(report.created_at),
    files: Array.isArray(report.files) ? report.files : [],
    items: itemsByReport.get(report.id) || []
  }));
}

async function uploadVercelBlob(objectPath, buffer, contentTypeValue) {
  const put = await getBlobPut();
  const blob = await put(objectPath, buffer, {
    access: "public",
    allowOverwrite: true,
    contentType: contentTypeValue || "application/octet-stream"
  });
  return blob.url;
}

function postgresReportRow(report) {
  return {
    id: report.id,
    title: report.title,
    risk_level: report.riskLevel,
    description: report.description || "",
    owner: report.owner || "",
    status: report.status || "검토 전",
    created_at: report.createdAt,
    files: report.files || []
  };
}

function postgresItemRow(item, index) {
  return {
    id: item.id,
    report_id: item.reportId,
    sort_index: index,
    image_url: item.imageUrl || "",
    screen_name: item.screenName || "",
    risk_level: normalizeAuditRisk(item.riskLevel || "보통"),
    fix: item.fix || "",
    reason: item.reason || "",
    checklist: item.checklist || "",
    area: item.area || "",
    source_file_name: item.sourceFileName || "",
    needs_review: Boolean(item.needsReview),
    uploaded_at: item.uploadedAt
  };
}

function auditItemFromPostgresRow(item) {
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
    uploadedAt: dateToIso(item.uploaded_at)
  };
}

function postgresHistoryFromRow(row) {
  return {
    action: row.action,
    reportId: row.report_id || "",
    itemId: row.item_id || "",
    snapshot: row.snapshot && typeof row.snapshot === "object" ? row.snapshot : {},
    createdAt: dateToIso(row.created_at)
  };
}

function dateToIso(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

async function saveAuditUploadFile(reportId, reportDir, file) {
  const name = safeFileName(file?.name || "attachment.bin");
  const dataUrl = typeof file?.dataUrl === "string" ? file.dataUrl : "";
  const match = dataUrl.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/);
  if (!match) return null;
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 20 * 1024 * 1024) return null;
  const type = match[1] || file.type || contentType(name);
  if (isVercelStorageEnabled()) {
    const objectPath = `${reportId}/${name}`;
    const url = await uploadVercelBlob(objectPath, buffer, type);
    return { name, type, size: buffer.length, url, path: objectPath, buffer };
  }
  const filePath = path.join(reportDir, name);
  await writeFile(filePath, buffer);
  const stats = await stat(filePath);
  return {
    name,
    type,
    size: stats.size,
    url: `/audit-files/${reportId}/${encodeURIComponent(name)}`,
    path: filePath,
    buffer
  };
}

function flattenAuditItems(reports) {
  return reports.flatMap((report) => (report.items || []).map((item) => ({
    ...item,
    reportTitle: report.title,
    files: report.files || []
  })));
}

async function extractAuditItemsFromFile(file, reportId) {
  try {
    if (/\.xlsx$/i.test(file.name)) return extractAuditItemsFromXlsx(file.buffer || readFileSync(file.path), file, reportId);
    if (/\.html?$/i.test(file.name)) return extractAuditItemsFromHtml((file.buffer || readFileSync(file.path)).toString("utf8"), file);
    if (/^image\//.test(file.type)) {
      return [{
        imageUrl: file.url,
        screenName: path.basename(file.name, path.extname(file.name)),
        riskLevel: "보통",
        fix: "",
        reason: "",
        checklist: "",
        area: "",
        sourceFileName: file.name
      }];
    }
  } catch {
    return [];
  }
  return [];
}

async function extractAuditItemsFromXlsx(buffer, file, reportId) {
  const entries = unzipEntries(buffer);
  const sheetXml = entries.get("xl/worksheets/sheet1.xml");
  if (!sheetXml) return [];
  const rows = parseXlsxRows(sheetXml.toString("utf8"));
  if (!rows.length) return [];
  const headerIndex = rows.findIndex((row) => row.some((cell) => /위험도/.test(cell)) && row.some((cell) => /보완점/.test(cell)));
  if (headerIndex === -1) return [];
  const headers = rows[headerIndex].map((cell) => cell.trim());
  const imageFile = [...entries.keys()].find((name) => /^xl\/media\/image\d+\.(png|jpg|jpeg)$/i.test(name));
  const imageName = imageFile ? embeddedImageName(file.name, imageFile) : "";
  const imageUrl = imageName ? `/audit-files/${reportId}/${encodeURIComponent(imageName)}` : "";
  if (imageFile) {
    const imageBuffer = entries.get(imageFile);
    if (isVercelStorageEnabled()) {
      const publicUrl = await uploadVercelBlob(`${reportId}/${imageName}`, imageBuffer, contentType(imageName));
      return rows.slice(headerIndex + 1)
        .filter((row) => row.some(Boolean))
        .map((row) => ({ ...auditItemFromCells(headers, row, publicUrl), sourceFileName: file.name }));
    }
    const mediaPath = path.join(path.dirname(file.path), imageName);
    try {
      if (!existsSync(mediaPath)) writeFileSync(mediaPath, imageBuffer);
    } catch {}
  }
  return rows.slice(headerIndex + 1)
    .filter((row) => row.some(Boolean))
    .map((row) => ({ ...auditItemFromCells(headers, row, imageUrl), sourceFileName: file.name }));
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

function embeddedImageName(fileName, imageFile) {
  const ext = path.extname(imageFile) || ".png";
  const base = path.basename(safeFileName(fileName), path.extname(fileName));
  return safeFileName(`${base}-${path.basename(imageFile, ext)}${ext}`);
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

function parseXlsxRows(xml) {
  return [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((rowMatch) =>
    [...rowMatch[1].matchAll(/<c[^>]*?(?:r="([A-Z]+)\d+")?[^>]*>([\s\S]*?)<\/c>/g)].reduce((cells, cellMatch) => {
      const col = cellMatch[1] ? columnIndex(cellMatch[1]) : cells.length;
      const text = [...cellMatch[2].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => xmlUnescape(match[1])).join("");
      cells[col] = cleanText(text);
      return cells;
    }, [])
  );
}

function columnIndex(name) {
  return String(name || "").split("").reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function xmlUnescape(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function unzipEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset < buffer.length - 4) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.slice(offset + 30, offset + 30 + nameLength).toString("utf8");
    const dataStart = offset + 30 + nameLength + extraLength;
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);
    const data = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : Buffer.alloc(0);
    if (data.length || uncompressedSize === 0) entries.set(name, data);
    offset = dataStart + compressedSize;
  }
  return entries;
}

function auditId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeAuditRisk(value) {
  if (/위험|높음|high/i.test(String(value))) return "위험";
  if (/낮음|low/i.test(String(value))) return "낮음";
  return "보통";
}

function safeFileName(value) {
  const ext = path.extname(String(value)).slice(0, 12);
  const base = path.basename(String(value), ext).replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "attachment";
  return `${base}${ext}`;
}

async function loadNemotronCandidates(target) {
  const cacheFresh = Date.now() - cacheAt < 1000 * 60 * 15;
  if (candidateCache.length >= 180 && cacheFresh) return candidateCache;

  try {
    const offsets = buildOffsets(target);
    const requests = offsets.map(async (offset) => {
      const params = new URLSearchParams({
        dataset: DATASET_NAME,
        config: "default",
        split: "train",
        offset: String(offset),
        length: "80"
      });
      const { response, payload } = await fetchJsonWithTimeout(`${DATASET_URL}?${params}`, {}, DATASET_FETCH_TIMEOUT_MS);
      if (!response.ok) throw new Error(`Hugging Face rows API HTTP ${response.status}`);
      return payload.rows || [];
    });

    const results = await Promise.all(requests);
    candidateCache = results.flat().map(normalizeRow).filter(Boolean);
    candidateSource = "huggingface";
  } catch {
    candidateCache = sampleCandidates();
    candidateSource = "built-in sample";
  }
  cacheAt = Date.now();
  return candidateCache;
}

function buildOffsets(text) {
  let seed = 17;
  for (const char of text) seed = (seed * 31 + char.charCodeAt(0)) % 999000;
  return Array.from({ length: 6 }, (_, index) => (seed + index * 137921) % 999000);
}

function normalizeRow(rowWrapper, index) {
  const row = rowWrapper.row || rowWrapper;
  if (!row) return null;
  return {
    id: `NPK-${row.uuid || rowWrapper.row_idx || index || Math.random().toString(36).slice(2)}`,
    age: row.age ?? "미상",
    sex: row.sex || "미상",
    province: row.province || "미상",
    district: row.district || "미상",
    occupation: row.occupation || "미상",
    education: row.education_level || "미상",
    maritalStatus: row.marital_status || "미상",
    persona: row.persona || "",
    professionalPersona: row.professional_persona || "",
    sportsPersona: row.sports_persona || "",
    artsPersona: row.arts_persona || "",
    travelPersona: row.travel_persona || "",
    culinaryPersona: row.culinary_persona || "",
    familyPersona: row.family_persona || "",
    skillsAndExpertise: row.skills_and_expertise || "",
    hobbiesAndInterests: row.hobbies_and_interests || "",
    careerGoals: row.career_goals_and_ambitions || "",
    culturalBackground: row.cultural_background || ""
  };
}

function rankCandidates(candidates, target) {
  const tokens = tokenize(target);
  return candidates
    .map((candidate) => {
      const haystack = candidateText(candidate);
      const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 5 : 0), 0)
        + demographicScore(candidate, target);
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((item) => item.candidate);
}

function demographicScore(candidate, target) {
  let score = 0;
  const age = Number(candidate.age);
  if (/10대|십대|청소년/.test(target) && age < 20) score += 10;
  if (/20대|이십대/.test(target) && age >= 20 && age < 30) score += 12;
  if (/30대|삼십대/.test(target) && age >= 30 && age < 40) score += 12;
  if (/40대|사십대/.test(target) && age >= 40 && age < 50) score += 12;
  if (/50대|오십대/.test(target) && age >= 50 && age < 60) score += 12;
  if (/여성|여자|female/i.test(target) && /female|여/i.test(candidate.sex)) score += 10;
  if (/남성|남자|male/i.test(target) && /male|남/i.test(candidate.sex)) score += 10;
  if (target.includes(candidate.province)) score += 10;
  if (target.includes(candidate.district)) score += 8;
  if (target.includes(candidate.occupation)) score += 8;
  return score;
}

function diversifyCandidates(candidates, count) {
  const picked = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.age}-${candidate.sex}-${candidate.province}-${candidate.occupation}`;
    if (seen.has(key) && picked.length < count - 1) continue;
    picked.push(candidate);
    seen.add(key);
    if (picked.length === count) break;
  }
  return picked.length ? picked : candidates.slice(0, count);
}

function buildFallbackResearch(target, question, selected, poolSize) {
  const interviews = selected.map((candidate, index) => {
    const stance = scoreCandidate(candidate, question, target, index);
    return {
      id: candidate.id,
      name: `P${index + 1}`,
      profile: profileSummary(candidate),
      answer: makeInterviewAnswer(candidate, question, stance),
      sentimentScore: stance.score,
      polarity: stance.score >= 7 ? "긍정" : stance.score >= 4 ? "중립" : "부정",
      reason: stance.reason,
      sourceValues: candidate
    };
  });

  const average = interviews.reduce((sum, item) => sum + item.sentimentScore, 0) / Math.max(1, interviews.length);
  return {
    target,
    question,
    dataset: {
      name: DATASET_NAME,
      type: candidateSource === "huggingface" ? "한국 인구통계 기반 합성 페르소나" : "내장 샘플 페르소나",
      source: candidateSource,
      candidatePool: poolSize,
      selectedCount: interviews.length
    },
    group: {
      title: summarizeGroup(target, selected),
      summary: `선정 표본은 평균 ${average.toFixed(1)}점 반응입니다. 관심사와 직업 맥락이 질문과 맞는 표본은 긍정적으로 반응하고, 가격·시간·신뢰 부담이 예상되는 표본은 조건부 반응을 보입니다.`,
      positiveRatio: `${Math.round(interviews.filter((item) => item.sentimentScore >= 7).length / Math.max(1, interviews.length) * 100)}%`,
      topDrivers: ["맥락 적합성", "실용성", "신뢰 형성"],
      frictions: ["가격 민감도", "초기 이해 비용", "기존 습관 전환"]
    },
    interviews
  };
}

function scoreCandidate(candidate, question, target, index) {
  const text = `${candidateText(candidate)} ${target}`.toLowerCase();
  const positiveTerms = ["ai", "디자인", "영상", "뷰티", "쇼핑", "기술", "생산성", "프리미엄", "업무", "콘텐츠", "여행", "요리", "스포츠"];
  let score = 5 + (index % 3) - 1;
  for (const term of positiveTerms) {
    if (text.includes(term.toLowerCase()) && question.toLowerCase().includes(term.toLowerCase())) score += 1;
  }
  if (/가격|비싸|유료|구매|결제/.test(question)) score -= /프리미엄|전문|관리|사업|임원/.test(text) ? 0 : 1;
  if (/쉽|편|시간|자동|추천/.test(question)) score += 1;
  score = Math.max(1, Math.min(10, score));
  const reason = score >= 7
    ? "본인의 관심사나 업무 맥락과 효용이 직접 연결됩니다."
    : score >= 4
      ? "필요성은 느끼지만 사용 조건과 신뢰 근거를 더 확인하려 합니다."
      : "현재 습관이나 비용 부담 대비 명확한 이득이 약합니다.";
  return { score, reason };
}

function makeInterviewAnswer(candidate, question, stance) {
  const context = [candidate.occupation, candidate.hobbiesAndInterests, candidate.professionalPersona]
    .filter(Boolean)
    .join(", ")
    .slice(0, 120);
  if (stance.score >= 7) {
    return `질문 "${question}"에 대해 저는 긍정적입니다. ${context} 맥락에서 바로 쓸 장면이 보이면 시도할 가능성이 높아요. 다만 실제 사용 전에는 결과 품질과 비용 구조를 확인하고 싶습니다.`;
  }
  if (stance.score >= 4) {
    return `관심은 있습니다. ${context}와 연결되면 한 번 살펴보겠지만, 처음 보는 서비스라면 예시와 후기, 가격 안내가 충분해야 움직일 것 같습니다.`;
  }
  return `지금 기준으로는 우선순위가 높지 않습니다. ${context}와 직접 연결되는 혜택이 명확하지 않으면 새로 배우거나 결제할 이유가 약하게 느껴집니다.`;
}

async function callGemini(target, question, selected, fallback) {
  const prompt = `너는 한국 유저 리서처다. 아래 Nemotron-Personas-Korea 합성 페르소나 5명을 표본으로 삼아 질문에 답하라.

주의:
- 실제 개인 데이터라고 말하지 말고 합성 페르소나라고 표현한다.
- 아래 5명 외의 개인을 만들지 않는다.
- JSON만 반환한다.
- interviews[].sourceValues는 입력 persona 값을 보존해 요약하지 말고 객체로 둔다.

타깃 그룹: ${target}
질문: ${question}
선정 표본: ${JSON.stringify(selected, null, 2)}
기본 스키마: ${JSON.stringify(fallback, null, 2)}
`;

  const body = {
    systemInstruction: {
      parts: [{ text: "한국어로 간결한 UX/유저 리서치 결과를 작성한다. JSON만 반환한다." }]
    },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.35,
      responseMimeType: "application/json"
    }
  };

  const errors = [];
  for (const model of GEMINI_MODELS) {
    const { response, payload } = await fetchGeminiGenerateContent(model, body);
    if (response.ok) {
      const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n") || "";
      return JSON.parse(text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
    }
    errors.push(`${model}: ${payload.error?.message || response.status}`);
    if (!shouldTryNextGeminiModel(response.status)) break;
  }
  throw new Error(errors.join(" / "));
}

function buildFallbackFigmaFeedback({ frameName, screenDescription, target, analysisMode, framesMeta, selected, poolSize }) {
  const text = `${frameName} ${screenDescription}`.toLowerCase();
  const readability = clampScore(6
    + (/명확|간결|큰 글씨|타이틀|라벨|구분|요약/.test(text) ? 1 : 0)
    - (/복잡|긴 문장|작은 글씨|정보 많|빽빽|혼란/.test(text) ? 1 : 0));
  const aesthetics = clampScore(6
    + (/정돈|모던|여백|일관|브랜드|이미지|컬러/.test(text) ? 1 : 0)
    - (/불균형|촌스|과한|색 많|어수선/.test(text) ? 1 : 0));
  const intuitiveness = clampScore(6
    + (/버튼|다음|완료|단계|진행|안내/.test(text) ? 1 : 0)
    - (/어디|모름|헷갈|숨겨|선택지 많|분기/.test(text) ? 1 : 0));

  const interviews = selected.map((candidate, index) => {
    const stance = scoreCandidate(candidate, screenDescription, target, index);
    return {
      id: candidate.id,
      name: `P${index + 1}`,
      profile: profileSummary(candidate),
      tooltip: tooltipProfile(candidate),
      score: stance.score,
      lines: makeFigmaInterviewLines(candidate, stance),
      sourceValues: candidate
    };
  });
  const groupSummary = summarizeFigmaGroup(target, selected);

  return {
    frameName,
    target,
    analysisMode,
    frames: framesMeta,
    dataset: {
      name: DATASET_NAME,
      type: candidateSource === "huggingface" ? "한국 인구통계 기반 합성 페르소나" : "내장 샘플 페르소나",
      source: candidateSource,
      candidatePool: poolSize,
      selectedCount: interviews.length
    },
    dashboard: {
      readability,
      aesthetics,
      intuitiveness,
      groupSummary,
      publicOpinion: [
        ...modePublicOpinion(analysisMode)
      ],
      summary: modeSummary(analysisMode, framesMeta)
    },
    interviews
  };
}

function normalizeAnalysisMode(value) {
  return ["single", "flow", "ui"].includes(value) ? value : "single";
}

function modeSummary(mode, framesMeta) {
  if (mode === "flow") {
    const frameCount = framesMeta.length || 1;
    return `${frameCount}개 프레임 흐름 기준으로 단계 전환, 선택 기준, 다음 행동의 명확성을 중심으로 점검했습니다. 이탈을 줄이려면 화면 간 용어와 주요 행동 흐름이 일관돼야 합니다.`;
  }
  if (mode === "ui") {
    return "선택 화면의 시각 위계, 정보 밀도, 버튼 우선순위, 문구 명확성을 중심으로 점검했습니다. 핵심 행동이 더 빠르게 보이도록 구조를 정리하는 것이 중요합니다.";
  }
  return "선택 프레임은 기본 사용성은 확보되어 있으나, 행동 유도와 정보 위계를 더 또렷하게 만들수록 대중 반응이 좋아질 가능성이 큽니다.";
}

function modePublicOpinion(mode) {
  if (mode === "flow") {
    return [
      "사용자는 이전 화면에서 선택한 내용이 다음 화면에 이어진다고 느낄 때 안심합니다.",
      "단계가 바뀔 때 같은 용어와 같은 버튼 위치가 유지되면 이해 부담이 줄어듭니다.",
      "중간 화면에서 선택 기준이 모호하면 사용자는 뒤로 가거나 비교를 반복할 수 있습니다.",
      "플로우 끝에서 완료 결과와 다음 행동을 명확히 보여주는 것이 중요합니다.",
      "여러 화면을 지나도 내가 어디까지 왔는지 알 수 있어야 이탈이 줄어듭니다."
    ];
  }
  if (mode === "ui") {
    return [
      "첫눈에 제목, 핵심 정보, 주 버튼의 순서가 보여야 합니다.",
      "장식보다 정보 위계가 먼저 잡힌 화면이 더 신뢰감을 줍니다.",
      "비슷한 카드나 옵션이 반복될수록 차이를 빠르게 비교할 단서가 필요합니다.",
      "색상 강조는 하나의 주요 행동에 집중될 때 가장 효과적입니다.",
      "작은 보조 문구는 사용자가 결정을 미루는 지점에서만 강하게 작동합니다."
    ];
  }
  return [
    "첫 화면에서 무엇을 해야 하는지는 비교적 빠르게 파악됩니다.",
    "핵심 버튼과 안내 문구가 더 강하게 보이면 이탈이 줄어들 수 있습니다.",
    "정보가 많은 화면이라면 제목, 요약, 행동 버튼의 위계가 중요합니다.",
    "시각 스타일은 신뢰감을 주되 과한 장식보다 정돈감이 더 긍정적으로 작동합니다.",
    "사용자는 다음 단계와 기대 결과가 명확할 때 더 편하게 진행합니다."
  ];
}

function clampScore(score) {
  return Math.max(1, Math.min(10, Math.round(score * 10) / 10));
}

function makeFigmaInterviewLines(candidate, stance) {
  const role = candidate.occupation || "사용자";
  if (stance.score >= 7) {
    return [
      `반응: ${role} 입장에서는 핵심 행동이 보이면 바로 이해할 가능성이 높습니다.`,
      "우려: 버튼 문구와 완료 후 결과가 모호하면 신뢰가 낮아질 수 있습니다.",
      "개선안: 주요 행동 근처에 완료 후 가능한 행동과 기대 결과를 짧게 붙여주세요."
    ];
  }
  if (stance.score >= 4) {
    return [
      `반응: ${role} 입장에서는 화면 의도는 이해하지만 한 번 더 확인하려는 지점이 있습니다.`,
      "우려: 정보량이 많거나 용어가 낯설면 다음 행동을 망설일 수 있습니다.",
      "개선안: 예시, 안내 문구, 버튼 우선순위를 한 화면 안에서 더 분명히 나눠주세요."
    ];
  }
  return [
    `반응: ${role} 입장에서는 화면의 핵심 이득이 즉시 와닿지 않습니다.`,
    "우려: 무엇을 누르면 어떤 결과가 생기는지 충분히 보이지 않습니다.",
    "개선안: 첫 문장과 주 버튼을 사용자의 다음 행동 하나에 맞춰 더 직접적으로 바꿔주세요."
  ];
}

function tooltipProfile(candidate) {
  return naturalLanguageProfile(candidate);
}

function naturalLanguageProfile(candidate) {
  return [
    `[기본] ${candidate.age}세 ${candidate.sex} · ${candidate.province} ${candidate.district} · ${candidate.occupation} · ${candidate.education}`,
    `[persona] ${candidate.persona || "없음"}`,
    `[professional_persona] ${candidate.professionalPersona || "없음"}`,
    `[hobbies_and_interests] ${candidate.hobbiesAndInterests || "없음"}`,
    `[skills_and_expertise] ${candidate.skillsAndExpertise || "없음"}`,
    `[family_persona] ${candidate.familyPersona || "없음"}`,
    `[career_goals_and_ambitions] ${candidate.careerGoals || "없음"}`,
    `[cultural_background] ${candidate.culturalBackground || "없음"}`
  ].join("\n");
}

function summarizeFigmaGroup(target, selected) {
  const ages = selected.map((item) => Number(item.age)).filter(Number.isFinite);
  const avgAge = ages.length ? `${Math.round(ages.reduce((sum, age) => sum + age, 0) / ages.length)}세 전후` : "연령 혼합";
  const locations = topValues(selected.map((item) => item.province)).join(", ");
  const jobs = topValues(selected.map((item) => item.occupation)).join(", ");
  const interests = topValues(selected.flatMap((item) => String(item.hobbiesAndInterests || "").split(",").map((value) => value.trim()))).join(", ");
  return `${target} 조건에 맞춰 추출한 ${avgAge} 중심의 합성 한국 페르소나 그룹입니다. 주요 지역은 ${locations || "혼합"}이고, 직업군은 ${jobs || "혼합"}입니다. 관심사는 ${interests || "생활 편의와 디지털 서비스"} 중심으로 분포합니다.`;
}

async function callGeminiFigmaFeedback({ frameName, screenDescription, target, analysisMode, framesMeta, textLayers, imageDataUrls, selected, fallback }) {
  const imageParts = imageDataUrls.slice(0, analysisMode === "flow" ? 3 : 1).map(dataUrlToGeminiPart).filter(Boolean);
  const modeLabel = analysisMode === "flow" ? "플로우 분석" : analysisMode === "ui" ? "UI피드백" : "단일화면 분석";
  const parts = [{
    text: `너는 한국 UX 리서처다. Figma에서 선택한 프레임 이미지를 보고 Nemotron-Personas-Korea 합성 페르소나 5명의 관점으로 디자인 피드백을 작성한다.

주의:
- 실제 개인 데이터라고 말하지 말고 합성 페르소나라고 표현한다.
- 이미지에 명확히 보이는 것만 근거로 삼고, 불확실하면 화면 설명 기반 가설이라고 표현한다.
- 분석 모드가 플로우 분석이면 여러 이미지의 순서, 전환, 선택 기준, 주요 행동의 일관성을 중심으로 본다.
- 분석 모드가 UI피드백이면 한 화면의 시각 위계, 정보 밀도, 심미성, 직관성을 중심으로 본다.
- 분석 모드가 단일화면 분석이면 화면 목적, 사용자 이해, 행동 유도를 중심으로 본다.
- 개인 인터뷰 lines는 반드시 3개 문자열만 작성한다.
- 개인 인터뷰 lines는 각각 "반응:", "우려:", "개선안:"으로 시작한다.
- dashboard.groupSummary에는 어떤 사용자 집단인지 2~3문장으로 요약한다.
- interviews[].tooltip에는 입력 표본의 자연어 설정값을 [persona], [professional_persona], [hobbies_and_interests] 형식으로 포함한다.
- dashboard.publicOpinion은 반드시 5개 문자열만 작성한다.
- JSON만 반환한다.

분석 모드: ${modeLabel}
프레임명: ${frameName}
프레임 목록: ${JSON.stringify(framesMeta, null, 2)}
대상 유저: ${target}
화면 설명: ${screenDescription}
텍스트 레이어:
${formatTextLayersForPrompt(textLayers)}
선정 표본: ${JSON.stringify(selected, null, 2)}
반환 스키마: ${JSON.stringify(fallback, null, 2)}
`
  }];
  parts.push(...imageParts);

  const body = {
    systemInstruction: {
      parts: [{ text: "한국어로 간결한 디자인 피드백을 작성한다. JSON만 반환한다." }]
    },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: "application/json"
    }
  };

  const errors = [];
  for (const model of GEMINI_MODELS) {
    const { response, payload } = await fetchGeminiGenerateContent(model, body);
    if (response.ok) {
      const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n") || "";
      const parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
      return normalizeFigmaFeedback(parsed, fallback);
    }
    errors.push(`${model}: ${payload.error?.message || response.status}`);
    if (!shouldTryNextGeminiModel(response.status)) break;
  }
  throw new Error(errors.join(" / "));
}

function normalizeFigmaFeedback(result, fallback) {
  const dashboard = Object.assign({}, fallback.dashboard, result.dashboard || {});
  dashboard.groupSummary = dashboard.groupSummary || fallback.dashboard.groupSummary;
  dashboard.publicOpinion = (dashboard.publicOpinion || fallback.dashboard.publicOpinion).slice(0, 5);
  const interviews = (result.interviews || fallback.interviews).slice(0, 5).map((item, index) => {
    const fallbackItem = fallback.interviews[index] || {};
    return Object.assign({}, fallbackItem, item, {
      tooltip: fallbackItem.tooltip || item.tooltip || "",
      lines: normalizeInterviewLines(item.lines || fallbackItem.lines || []),
      sourceValues: fallbackItem.sourceValues || item.sourceValues
    });
  });
  return Object.assign({}, fallback, result, { dashboard, interviews });
}

function normalizeInterviewLines(lines) {
  const normalized = lines.slice(0, 3);
  const labels = ["반응:", "우려:", "개선안:"];
  return labels.map((label, index) => {
    const line = normalized[index] || "";
    return line.startsWith(label) ? line : `${label} ${line}`;
  });
}

function buildFallbackFrameDescription(frameName, textLayers) {
  const visibleTexts = textLayers.map((layer) => layer.text).filter(Boolean).slice(0, 8);
  if (visibleTexts.length) {
    return [
      `${frameName} 화면은 "${visibleTexts.slice(0, 3).join(", ")}" 등의 문구를 중심으로 사용자가 내용을 확인하는 화면입니다.`,
      "주요 정보와 다음 행동을 이해하기 쉬운지 확인하는 맥락으로 보입니다."
    ].join("\n");
  }
  return [
    `${frameName} 화면은 사용자가 주요 정보를 확인하고 다음 행동을 판단하는 화면으로 보입니다.`,
    "구체적인 목적과 사용 상황은 필요에 맞게 수정해 주세요."
  ].join("\n");
}

async function callGeminiFrameDescription({ frameName, imageDataUrl, textLayers, fallback }) {
  const imagePart = dataUrlToGeminiPart(imageDataUrl);
  const parts = [{
    text: `Figma 프레임 이미지를 보고 화면 설명 입력란에 넣을 초안을 작성해줘.

조건:
- 한국어로 작성
- 반드시 2줄 이내
- 사용자가 이후 수정할 수 있는 초안처럼 자연스럽게 작성
- 이미지에서 확실히 보이는 화면 목적과 주요 행동만 설명
- 과장, 추측, 평가 금지
- JSON만 반환: {"description":"..."}

프레임명: ${frameName}
텍스트 레이어:
${formatTextLayersForPrompt(textLayers)}

fallback 예시:
${fallback}
`
  }];
  if (imagePart) parts.push(imagePart);

  const body = {
    systemInstruction: {
      parts: [{ text: "화면 설명 초안을 짧고 명확하게 작성한다. JSON만 반환한다." }]
    },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json"
    }
  };

  const errors = [];
  for (const model of GEMINI_MODELS) {
    const { response, payload } = await fetchGeminiGenerateContent(model, body);
    if (response.ok) {
      const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n") || "";
      const parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
      return limitDescriptionLines(parsed.description || fallback);
    }
    errors.push(`${model}: ${payload.error?.message || response.status}`);
    if (!shouldTryNextGeminiModel(response.status)) break;
  }
  throw new Error(errors.join(" / "));
}

function limitDescriptionLines(value) {
  return String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join("\n");
}

function normalizeTextLayers(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      name: cleanText(item.name || ""),
      text: cleanText(item.text || ""),
      x: safeNumber(item.x),
      y: safeNumber(item.y),
      width: safeNumber(item.width),
      height: safeNumber(item.height),
      fontSize: safeNumber(item.fontSize)
    }))
    .filter((item) => item.text)
    .slice(0, 160);
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 10) / 10 : null;
}

function formatTextLayersForPrompt(textLayers) {
  return textLayers
    .slice(0, 120)
    .map((layer, index) => {
      const size = layer.fontSize ? `font ${layer.fontSize}` : "font unknown";
      return `${index + 1}. "${layer.text}" (${size}, x:${layer.x ?? "?"}, y:${layer.y ?? "?"}, w:${layer.width ?? "?"}, h:${layer.height ?? "?"}, layer:${layer.name || "unnamed"})`;
    })
    .join("\n");
}

function buildFallbackDarkPatternCheck({ frameName, frameMeta, screenDescription, businessContext, textLayers, selected, poolSize }) {
  const context = `${frameName} ${screenDescription} ${businessContext} ${textLayers.map((layer) => layer.text).join(" ")}`;
  const screenElementMap = buildScreenElementMap(textLayers);
  const userMentalModel = buildUserMentalModel({ frameName, screenDescription, businessContext, textLayers, screenElementMap });
  const violations = detectDarkPatternSignals(context).slice(0, 3);
  const riskLevel = violations.some((item) => item.severity === "높음")
    ? "높음"
    : violations.length
      ? "보통"
      : "낮음";
  const affectedGroups = buildAffectedGroups(violations, selected);
  const improvementItems = buildImprovementItems(violations);

  return {
    frameName,
    frameMeta,
    aiMode: "fallback",
    overall: {
      riskLevel,
      summary: buildOverallSummary(riskLevel, improvementItems),
      reviewBasis: ""
    },
    userMentalModel,
    screenElementMap,
    violations: riskLevel === "낮음" ? [] : violations,
    improvementItems: riskLevel === "낮음" ? [] : improvementItems,
    affectedGroups: riskLevel === "낮음" ? [] : affectedGroups,
    sources: DARK_PATTERN_SOURCES
  };
}

function buildOverallSummary(riskLevel, improvementItems) {
  if (riskLevel === "낮음") return "다크패턴이 검출되지 않았습니다";
  const item = pickPriorityImprovementItem(improvementItems);
  const text = `${item.area || ""} ${item.checklist || ""} ${item.reason || ""} ${item.fix || ""}`;
  return easyFeedbackAction(text, riskLevel);
}

function pickPriorityImprovementItem(improvementItems) {
  const items = Array.isArray(improvementItems) ? improvementItems : [];
  return items
    .map((item, index) => ({
      item,
      score: priorityScoreForImprovement(item) - (index * 0.01)
    }))
    .sort((a, b) => b.score - a.score)[0]?.item || {};
}

function priorityScoreForImprovement(item) {
  const text = `${item.area || ""} ${item.checklist || ""} ${item.reason || ""} ${item.fix || ""}`;
  let score = 0;
  if (/비용|금액|가격|수수료|월회비|환불|불이익|위험|조건/.test(text)) score += 5;
  if (/숨|누락|고지|정보|위계|명확|인지|확인/.test(text)) score += 4;
  if (/압박|불안|감정|긴급|마감|손실|재고/.test(text)) score += 3;
  if (/경로|방해|혼란|찾기|순서|흐름/.test(text)) score += 2;
  if (/동의|선택|옵션|기본값/.test(text)) score += 2;
  return score;
}

function easyFeedbackAction(text, riskLevel) {
  const isHigh = riskLevel === "높음";
  if (/비용|금액|가격|수수료|월회비|환불/.test(text)) {
    return isHigh ? "사용자가 내야 할 금액을 바로 알 수 있게 보여주세요." : "사용자가 내야 할 금액이 바로 보이는지 확인해 주세요.";
  }
  if (/불이익|위험|조건|제한|유의/.test(text)) {
    return isHigh ? "선택 전에 꼭 알아야 할 조건을 눈에 띄게 보여주세요." : "선택 전에 꼭 알아야 할 조건이 잘 보이는지 확인해 주세요.";
  }
  if (/압박|불안|감정|긴급|마감|손실|재고/.test(text)) {
    return isHigh ? "사용자를 불안하게 만드는 표현을 줄여주세요." : "사용자를 불안하게 만드는 표현이 있는지 확인해 주세요.";
  }
  if (/숨|누락|고지|정보|위계|인지|확인/.test(text)) {
    return isHigh ? "중요한 정보를 사용자가 쉽게 찾게 해주세요." : "중요한 정보를 사용자가 쉽게 찾는지 확인해 주세요.";
  }
  if (/경로|방해|혼란|찾기|순서|흐름/.test(text)) {
    return isHigh ? "사용자가 원하는 다음 행동을 쉽게 찾게 해주세요." : "사용자가 원하는 다음 행동을 쉽게 찾는지 확인해 주세요.";
  }
  if (/동의|선택|옵션|기본값/.test(text)) {
    return isHigh ? "선택 항목의 의미와 결과를 분명히 알려주세요." : "선택 항목의 의미와 결과가 분명한지 확인해 주세요.";
  }
  return isHigh ? "사용자가 헷갈리지 않게 핵심 정보를 쉽게 보여주세요." : "사용자가 핵심 정보를 쉽게 이해하는지 확인해 주세요.";
}

function buildUserMentalModel({ frameName, screenDescription, businessContext, textLayers, screenElementMap }) {
  const text = `${frameName} ${screenDescription} ${businessContext} ${textLayers.map((layer) => layer.text).join(" ")}`;
  if (/해지|취소|철회|탈퇴|환불|환급/.test(text)) {
    return {
      userGoal: "이용 중인 서비스나 계약 상태를 변경하거나 중단한다.",
      expectedNextAction: screenElementMap.goalRelatedAction || "의도한 변경 절차를 계속 진행한다.",
      expectedInformation: "처리 결과, 불이익, 비용, 복구 가능 여부, 완료 시점",
      riskIfMissing: "처리 결과나 불이익을 오해하고 의도한 절차를 멈출 수 있다.",
      normalPath: "핵심 조건 확인 후 사용자가 의도한 절차를 명확히 선택한다."
    };
  }
  if (/가입|신청|동의|결제|구매|구독/.test(text)) {
    return {
      userGoal: "상품이나 서비스 가입 여부를 판단한다.",
      expectedNextAction: screenElementMap.goalRelatedAction || "조건을 확인한 뒤 진행 여부를 선택한다.",
      expectedInformation: "가격, 필수 조건, 선택 동의, 해지 조건, 위험 또는 불이익",
      riskIfMissing: "혜택만 보고 비용이나 조건을 뒤늦게 인지할 수 있다.",
      normalPath: "핵심 조건 확인 후 명확한 신청 또는 취소 선택지를 고른다."
    };
  }
  return {
    userGoal: "화면의 핵심 정보를 이해하고 다음 행동을 결정한다.",
    expectedNextAction: screenElementMap.goalRelatedAction || "가장 명확한 다음 행동을 선택한다.",
    expectedInformation: "결정에 필요한 핵심 조건, 비용, 위험, 다음 단계",
    riskIfMissing: "다음 행동의 결과를 오해하거나 불필요하게 망설일 수 있다.",
    normalPath: "중요 정보 확인 후 의도한 행동으로 자연스럽게 진행한다."
  };
}

function buildScreenElementMap(textLayers) {
  const sorted = [...textLayers].sort((a, b) => (b.fontSize || 0) - (a.fontSize || 0));
  const byText = (pattern) => textLayers.find((layer) => pattern.test(layer.text || ""))?.text || "";
  const actionCandidates = textLayers.filter((layer) => /하기|진행|계속|확인|다음|가입|신청|동의|결제|변경|완료|선택|닫기|이전/.test(layer.text || ""));
  const prominentAction = actionCandidates.sort((a, b) => (b.fontSize || 0) - (a.fontSize || 0) || (b.width || 0) - (a.width || 0))[0]?.text || sorted[0]?.text || "";
  return {
    prominentAction,
    goalRelatedAction: byText(/진행|확인|다음|완료|변경|신청|선택|처리|계속/),
    alternativeAction: actionCandidates.find((layer) => layer.text !== prominentAction)?.text || "",
    criticalInformation: byText(/유의|불이익|복구|위험|손실|조건|수수료|가격|비용|결제|환급|환불/),
    costOrCondition: byText(/원|가격|비용|조건|결제|수수료|환급|환불/),
    pressureCopy: byText(/지금|오늘|마감|한정|놓치|손해|불가|없어요|종료/),
    ambiguousCopy: byText(/확인|동의|계속|나중에|기타/)
  };
}

function buildImprovementItems(violations) {
  return violations.slice(0, 6).map((violation) => ({
    severity: violation.severity === "높음" ? "높음" : "보통",
    area: cleanText(violation.title || "검토 필요 요소"),
    checklist: cleanText(violation.darkPatternType || violation.checklistEvidence || "검토 필요"),
    reason: cleanText(violation.screenEvidence || violation.whyItMatters || "사용자 판단을 어렵게 할 수 있음"),
    fix: cleanText(violation.suggestion || "문구와 정보 위계를 명확히 조정하세요.")
  }));
}

function detectDarkPatternSignals(context) {
  const text = context.toLowerCase();
  const signals = [
    {
      pattern: /((목표|진행|완료|변경|신청|처리|중단|취소|거절).{0,100}(다른\s*선택|추천|유도|우회|상담|추가\s*확인))|((다른\s*선택|추천|유도|우회|상담|추가\s*확인).{0,100}(목표|진행|완료|변경|신청|처리|중단|취소|거절))/,
      title: "사용자 목표 달성 경로가 흐려짐",
      severity: "높음",
      darkPatternType: "시각적 간섭 / 목표 경로 방해 / 오인 유도",
      screenEvidence: "사용자가 기대하는 정상 경로와 다른 선택 또는 우회 행동이 함께 강조될 가능성이 있습니다.",
      checklistEvidence: "사용자의 목적 달성을 어렵게 하거나 다른 선택으로 유도하는 구성은 시각적 간섭과 오인 유도 관점에서 검토할 수 있습니다.",
      whyItMatters: "사용자는 현재 화면에서 무엇을 선택해야 목표를 달성하는지 헷갈릴 수 있습니다.",
      suggestion: "사용자 목표와 직접 연결된 행동을 명확히 제시하고, 보조 행동은 분리해 안내하세요."
    },
    {
      pattern: /기본\s*선택|자동\s*선택|미리\s*선택|선택되어|체크되어|동의\s*완료|전체\s*동의/,
      title: "동의 또는 선택의 기본값 유도",
      severity: "높음",
      darkPatternType: "기본 선택 / 오인 유도",
      screenEvidence: "설명에 기본 선택, 자동 선택, 전체 동의처럼 사용자가 명시적으로 고르기 전 선택이 정해질 수 있는 표현이 포함됩니다.",
      checklistEvidence: "온라인 다크패턴 자율관리 기준의 사전 선택, 오인 유도, 소비자 선택권 제한 유형과 연결해 검토할 필요가 있습니다.",
      whyItMatters: "디지털 숙련도가 낮거나 금융 약관에 익숙하지 않은 집단은 선택 결과를 충분히 인지하지 못한 채 다음 단계로 진행할 수 있습니다.",
      suggestion: "선택 해제 상태를 기본으로 두고 필수·선택 항목과 결과를 분리해 표시하세요."
    },
    {
      pattern: /숨김|작은\s*글씨|회색|하단|접기|더보기|약관에|유의사항|유의|수수료|위험|불이익|조건|비용|제한/,
      title: "중요 정보의 낮은 시각적 위계",
      severity: "보통",
      darkPatternType: "숨은 정보 / 정보 위계 왜곡",
      screenEvidence: "화면 설명 또는 텍스트 레이어에 조건, 비용, 유의사항, 불이익 같은 중요 정보가 포함되어 있어 위치와 시각적 위계 확인이 필요합니다.",
      checklistEvidence: "중요 정보를 찾기 어렵게 하거나 구매·가입 판단에 필요한 조건을 뒤늦게 알리는 구성은 다크패턴 및 금융소비자 설명의무 관점에서 검토 대상입니다.",
      whyItMatters: "금융 이해도가 낮거나 비교 검토 시간이 부족한 사용자는 비용·위험·불이익을 나중에 인지할 가능성이 있습니다.",
      suggestion: "비용, 위험, 불이익, 조건은 주요 행동 전에 같은 화면에서 충분히 인지되도록 노출하세요."
    },
    {
      pattern: /마감|오늘만|한정|지금\s*안하면|곧\s*종료|남은\s*시간|카운트|혜택\s*종료/,
      title: "시간 압박 중심의 의사결정 유도",
      severity: "높음",
      darkPatternType: "반복 압박 / 긴급성 유도",
      screenEvidence: "설명에 마감, 한정, 지금 안 하면, 남은 시간처럼 즉시 결정을 압박하는 표현이 포함됩니다.",
      checklistEvidence: "근거가 불충분한 긴급성·희소성 강조는 소비자가 비교·숙고할 기회를 줄이는 다크패턴 유형으로 검토할 수 있습니다.",
      whyItMatters: "가격 민감도나 신뢰 민감도가 높은 집단은 손실 회피 압박으로 상품 조건을 충분히 확인하지 못할 수 있습니다.",
      suggestion: "혜택 조건과 종료 사유를 명확히 밝히고, 핵심 조건 확인 후 결정할 수 있게 흐름을 조정하세요."
    },
    {
      pattern: /취소.*어려|해지.*전화|탈퇴.*상담|돌아가기.*불가|닫기.*없|거절.*작|나중에.*흐림/,
      title: "취소·거절 경로의 접근성 저하",
      severity: "높음",
      darkPatternType: "취소 방해 / 선택 방해",
      screenEvidence: "설명에 취소, 해지, 거절, 나중에 선택이 약하거나 복잡해질 수 있는 흐름이 포함됩니다.",
      checklistEvidence: "동의·가입은 쉽게 만들고 취소·거절은 어렵게 만드는 구조는 온라인 다크패턴의 취소 방해 유형과 연결됩니다.",
      whyItMatters: "모바일 사용이 익숙하지 않거나 상담 절차 부담이 큰 사용자는 원치 않는 가입·동의를 유지할 가능성이 있습니다.",
      suggestion: "수락과 거절, 가입과 해지 경로를 같은 화면 위계와 비슷한 단계 수로 제공하세요."
    },
    {
      pattern: /무료|0원|공짜|캐시백|포인트|고수익|수익\s*보장|확정\s*수익|무조건/,
      title: "혜택 강조 대비 조건 설명 부족 가능성",
      severity: "보통",
      darkPatternType: "오인 유도 / 중요 조건 누락",
      screenEvidence: "무료, 확정 수익, 무조건 같은 강한 긍정 표현이 있을 때 제한 조건과 위험 고지가 함께 충분한지 확인이 필요합니다.",
      checklistEvidence: "긍정 표현만 부각하고 제한 조건, 비용, 위험, 예외를 충분히 고지하지 않는 경우 소비자 오인 유발 관점에서 검토 대상이 됩니다.",
      whyItMatters: "사용자는 조건이나 예외를 뒤늦게 발견해 기대와 다른 결과를 겪을 수 있습니다.",
      suggestion: "강한 긍정 표현을 사용할 때는 적용 조건, 제외 대상, 비용·위험을 같은 단계에서 함께 안내하세요."
    }
  ];

  return signals.filter((signal) => signal.pattern.test(text)).map(({ pattern, ...signal }) => signal);
}

function buildAffectedGroups(violations, selected) {
  const user = mostAffectedUser(selected);
  if (!violations.length) {
    return [
      {
        group: "가장 주의 깊게 확인할 사용자",
        emotion: "이 화면에서 다음 행동을 선택하기가 망설여져요",
        difficulty: "이 화면에서 다음 행동을 선택하기가 망설여져요",
        reasonFromPersonaData: briefUserProfile(user),
        userProfile: briefUserProfile(user),
        personaDetail: detailedUserProfile(user),
        selectionReason: "핵심 정보를 신중하게 확인할 가능성이 높아 선정됨",
        relatedViolation: "명확한 고위험 요소 없음"
      }
    ];
  }

  const firstViolation = violations[0];
  return [
    {
      group: userGroupName(firstViolation),
      emotion: emotionSentenceForViolation(firstViolation),
      difficulty: emotionSentenceForViolation(firstViolation),
      reasonFromPersonaData: briefUserProfile(user),
      userProfile: briefUserProfile(user),
      personaDetail: detailedUserProfile(user),
      selectionReason: selectionReasonForViolation(firstViolation),
      relatedViolation: violations.map((violation) => violation.title).join(", ")
    }
  ];
}

function emotionSentenceForViolation(violation) {
  if (/시간|압박|마감|긴급/.test(violation.title)) return "지금 바로 선택해야 할 것 같아 마음이 급해져요";
  if (/목표|경로|방해|오인/.test(violation.title)) return "어떤 순서로 진행해야 할지 판단하기 어려워요";
  if (/정보|조건|유의|비용/.test(violation.title)) return "중요한 조건을 놓친 채 진행할까 봐 걱정돼요";
  if (/동의|선택/.test(violation.title)) return "무엇에 동의한 건지 명확하지 않아 망설여져요";
  return "이 화면에서 다음 행동을 선택하기가 망설여져요";
}

function userGroupName(violation) {
  if (/목표|경로|방해|오인/.test(violation.title)) return "화면 목적 파악에 시간이 필요한 사용자";
  if (/시간|압박/.test(violation.title)) return "시간 압박에 취약한 신중형 사용자";
  if (/정보|조건|비용/.test(violation.title)) return "중요 조건 확인이 필요한 사용자";
  return "디지털 동의 절차에 익숙하지 않은 사용자";
}

function selectionReasonForViolation(violation) {
  if (/목표|경로|방해|오인/.test(violation.title)) return "화면 흐름을 오해하기 쉬워 선정됨";
  if (/시간|압박/.test(violation.title)) return "빠른 선택 압박에 흔들릴 수 있어 선정됨";
  if (/정보|조건|비용/.test(violation.title)) return "중요 조건을 놓치기 쉬워 선정됨";
  if (/동의|선택/.test(violation.title)) return "선택 결과를 오해하기 쉬워 선정됨";
  return "이 화면에서 가장 영향을 받기 쉬워 선정됨";
}

function mostAffectedUser(selected) {
  return selected
    .map((candidate) => ({
      candidate,
      score: (/자영업|교사|대학생|프리랜서/.test(candidate.occupation) ? 3 : 0)
        + (/천천히|안전|신뢰|가격|가성비|복잡|구독|개인정보|평판/.test(candidateText(candidate)) ? 4 : 0)
        + (Number(candidate.age) >= 45 ? 1 : 0)
    }))
    .sort((a, b) => b.score - a.score)[0]?.candidate || selected[0] || {};
}

function briefUserProfile(candidate) {
  const age = candidate.age ? `${candidate.age}세` : "연령 미상";
  const sex = displaySex(candidate.sex);
  const job = candidate.occupation || "직업 미상";
  const location = [candidate.province, candidate.district].filter((value) => value && value !== "미상").join(" ");
  const interest = topValues(String(candidate.hobbiesAndInterests || "").split(",").map((value) => value.trim())).slice(0, 2).join(", ");
  return [age, sex, location, job, interest ? `관심사: ${interest}` : ""].filter(Boolean).join(" · ");
}

function detailedUserProfile(candidate) {
  return [
    `나이: ${candidate.age || "미상"}`,
    `성별: ${displaySex(candidate.sex)}`,
    `지역: ${[candidate.province, candidate.district].filter((value) => value && value !== "미상").join(" ") || "미상"}`,
    `직업: ${candidate.occupation || "미상"}`,
    `학력: ${candidate.education || "미상"}`,
    `생활 특성: ${candidate.persona || "미상"}`,
    `업무 특성: ${candidate.professionalPersona || "미상"}`,
    `관심사: ${candidate.hobbiesAndInterests || "미상"}`,
    `역량: ${candidate.skillsAndExpertise || "미상"}`,
    `목표: ${candidate.careerGoals || "미상"}`
  ].join("\n");
}

function displaySex(value) {
  if (/female|여/i.test(String(value || ""))) return "여성";
  if (/male|남/i.test(String(value || ""))) return "남성";
  return "성별 미상";
}

function shortenSentence(text, maxLength) {
  const value = cleanText(text);
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function limitTextLength(text, maxLength) {
  const value = cleanText(text);
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function plainTextValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return cleanText(value);
  if (Array.isArray(value)) return cleanText(value.map(plainTextValue).filter(Boolean).join(" "));
  if (typeof value === "object") {
    const preferred = value.text || value.quote || value.sentence || value.summary || value.emotion || value.difficulty || value.value || value.label;
    if (preferred) return plainTextValue(preferred);
    return cleanText(Object.values(value).map(plainTextValue).filter(Boolean).join(" "));
  }
  return "";
}

function profilePlainText(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const age = value.age ? `${value.age}세` : "";
    const gender = value.gender || value.sex || "";
    const location = [value.province, value.city, value.district, value.location].filter(Boolean).join(" ");
    const job = value.job || value.occupation || "";
    const interest = value.interest || value.interests || value.hobbiesAndInterests || "";
    const structured = [age, gender, location, job, interest ? `관심사: ${plainTextValue(interest)}` : ""].filter(Boolean).join(" · ");
    if (structured) return cleanText(structured);
  }
  return plainTextValue(value);
}

function normalizeInterviewSentence(value) {
  const fallback = "이 화면에서 다음 행동을 선택하기가 망설여져요";
  const text = plainTextValue(value);
  return text || fallback;
}

async function callGeminiDarkPatternCheck({ frameName, frameMeta, screenDescription, businessContext, textLayers, imageDataUrl, selected, fallback }) {
  const imagePart = dataUrlToGeminiPart(imageDataUrl);
  const textLayerSummary = formatTextLayersForPrompt(textLayers);
  const parts = [{
    text: `너는 한국 금융/커머스 UX 다크패턴 검토자다. Figma 선택 프레임 이미지를 보고 공식 기준과 내부 합성 사용자 표본을 바탕으로 검토 결과를 JSON으로 작성한다.

반드시 지킬 원칙:
- 결과를 만들기 전에 반드시 userMentalModel을 먼저 정의한다.
- userMentalModel.userGoal에는 사용자가 이 화면에 들어온 목적을 쓴다.
- userMentalModel.expectedNextAction에는 사용자가 기대하는 정상 다음 행동을 쓴다.
- userMentalModel.expectedInformation에는 사용자가 판단하려면 필요한 핵심 정보를 쓴다.
- userMentalModel.riskIfMissing에는 그 정보나 행동 경로가 약할 때 생기는 오해를 쓴다.
- screenElementMap에는 텍스트 레이어를 prominentAction, goalRelatedAction, alternativeAction, criticalInformation, costOrCondition, pressureCopy, ambiguousCopy로 분류한다.
- 다크패턴 판단은 먼저 userMentalModel의 정상 기대 경로와 실제 화면 구성을 비교한 뒤, 차이가 큰 항목만 남긴다.
- 단순히 작은 글씨나 많은 정보라는 이유만으로 지적하지 않는다. 사용자 목표 달성에 필요한 정보나 행동 경로가 약해질 때만 지적한다.
- 법률 자문처럼 단정하지 말고 "위반 가능성", "검토 필요"로 표현한다.
- 텍스트 문구 판단은 이미지 OCR보다 Figma 텍스트 레이어 목록을 우선 근거로 삼는다.
- 버튼 문구, 유의사항, 금액, 조건, 위험 또는 제한 관련 문구는 텍스트 레이어에서 확인된 내용만 확정적으로 언급한다.
- 이미지에 실제로 보이거나 텍스트 레이어/화면 설명/추가 요청에서 강하게 추론되는 요소만 다룬다.
- 화면에 실제로 보이는 텍스트나 화면 설명에 없는 "비용, 위험, 불이익, 조건" 같은 일반론을 임의로 만들지 않는다.
- 각 improvementItems.reason과 fix는 반드시 해당 프레임의 구체 문구/구성/흐름에 연결해서 작성한다.
- 구체 근거를 찾지 못하면 억지로 보통을 만들지 말고 riskLevel을 "낮음"으로 둔다.
- 사소하거나 애매한 지적은 제거하고, violations는 최대 4개만 둔다.
- improvementItems를 반드시 작성한다. 컬럼은 area, checklist, reason, fix만 사용한다.
- improvementItems[].area는 개선영역, checklist는 개선체크리스트 또는 법률상 검토 근거, reason은 말줄임표 없이 핵심 이유를 완결된 문장으로 쓴다. fix는 보완점이다.
- 사용자의 원래 목표 달성을 어렵게 만드는 정보 부족, 경로 혼란, 과도한 압박, 선택 구조 왜곡만 검토한다.
- 특정 예시 문구를 일반화하지 말고, 입력된 텍스트 레이어와 화면 설명에 실제 존재하는 문구만 근거로 삼는다.
- overall.summary는 아래 개선안 전체를 쉽게 함축하는 1문장으로 쓴다.
- 검출 내용이 많아 1문장 요약이 어렵다면 가장 위험한 항목 1개만 골라 직관적인 피드백으로 쓴다.
- overall.summary에는 어려운 심사 용어보다 사용자가 바로 이해할 수 있는 표현을 쓴다.
- riskLevel이 "높음"이면 바로 고쳐야 할 문장으로, "보통"이면 확인해 달라는 문장으로 쓴다.
- riskLevel이 "낮음"이면 violations, improvementItems, affectedGroups를 빈 배열로 두고 overall.summary는 "다크패턴이 검출되지 않았습니다"로 쓴다.
- affectedGroups는 반드시 1개만 작성한다.
- affectedGroups[0]는 가장 취약한 사용자 1명을 대표 사용자처럼 정한다.
- affectedGroups[0].emotion은 취약 사용자가 실제로 말하는 듯한 자연스러운 인터뷰 문장이다. 억지로 요약하지 말고 핵심 감정을 담는다.
- affectedGroups[0].userProfile에는 해당 사용자의 나이, 성별, 지역, 직업, 주요 관심사만 간략히 쓴다.
- affectedGroups[0].selectionReason에는 이 사람이 취약 사용자로 선정된 이유를 20자 내외로 간략히 쓴다.
- affectedGroups[0].personaDetail에는 상세 사용자 특성을 자연어로 작성한다. 데이터셋명, 표본 ID, 개발 용어는 쓰지 않는다.
- 결과 텍스트에는 "Nemotron", "SAMPLE-001" 같은 데이터셋명, 내부 ID, 표본 ID를 절대 쓰지 않는다.
- 각 violations 항목에는 screenEvidence, checklistEvidence, whyItMatters를 모두 채운다.
- 출처명은 sources에만 두고 overall.summary에는 쓰지 않는다.
- JSON만 반환한다.

공식 출처:
${JSON.stringify(DARK_PATTERN_SOURCES, null, 2)}

프레임명: ${frameName}
프레임 메타: ${JSON.stringify(frameMeta, null, 2)}
화면 설명: ${screenDescription}
추가 요청: ${businessContext}
Figma 텍스트 레이어(위에서 아래, 왼쪽에서 오른쪽 순):
${textLayerSummary || "텍스트 레이어 없음"}
내부 합성 사용자 표본(출력에 id를 쓰지 말 것): ${JSON.stringify(selected, null, 2)}
반환 JSON 구조:
${JSON.stringify(darkPatternResponseSchema(), null, 2)}
`
  }];
  if (imagePart) parts.push(imagePart);

  const body = {
    systemInstruction: {
      parts: [{ text: "한국어로 간결하고 보수적인 다크패턴 검토 결과를 작성한다. JSON만 반환한다." }]
    },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json"
    }
  };

  const errors = [];
  for (const model of GEMINI_MODELS) {
    const { response, payload } = await fetchGeminiGenerateContent(model, body);
    if (response.ok) {
      const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n") || "";
      const parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
      return normalizeDarkPatternCheck(parsed, fallback);
    }
    errors.push(`${model}: ${payload.error?.message || response.status}`);
    if (!shouldTryNextGeminiModel(response.status)) break;
  }
  throw new Error(errors.join(" / "));
}

function darkPatternResponseSchema() {
  return {
    overall: {
      riskLevel: "낮음 | 보통 | 높음",
      summary: "검토 결과를 쉬운 한 문장으로 작성"
    },
    userMentalModel: {
      userGoal: "사용자가 이 화면에 들어온 목적",
      expectedNextAction: "사용자가 기대하는 정상 다음 행동",
      expectedInformation: "사용자가 판단에 필요한 핵심 정보",
      riskIfMissing: "정보나 경로가 약할 때 생기는 오해",
      normalPath: "정상적인 화면 이용 흐름"
    },
    screenElementMap: {
      prominentAction: "",
      goalRelatedAction: "",
      alternativeAction: "",
      criticalInformation: "",
      costOrCondition: "",
      pressureCopy: "",
      ambiguousCopy: ""
    },
    violations: [
      {
        title: "실제 화면에서 확인한 문제 영역",
        severity: "보통 | 높음",
        darkPatternType: "검토 기준",
        screenEvidence: "텍스트 레이어나 이미지에서 확인한 근거",
        checklistEvidence: "법률/가이드라인상 검토 근거",
        whyItMatters: "사용자 목표를 방해하는 이유",
        suggestion: "구체적인 보완 방향"
      }
    ],
    improvementItems: [
      {
        severity: "보통 | 높음",
        area: "개선영역",
        checklist: "개선체크리스트 또는 법률상 검토 근거",
        reason: "개선 이유",
        fix: "보완점"
      }
    ],
    affectedGroups: [
      {
        emotion: "취약 사용자가 실제로 말하는 한 문장",
        userProfile: "나이 · 성별 · 지역 · 직업 · 관심사",
        selectionReason: "취약 사용자로 선정한 이유",
        personaDetail: "상세 사용자 특성"
      }
    ],
    sources: DARK_PATTERN_SOURCES
  };
}

function normalizeDarkPatternCheck(result, fallback) {
  const resultViolations = Array.isArray(result.violations) ? result.violations.slice(0, 4) : [];
  const rawImprovementItems = Array.isArray(result.improvementItems) ? result.improvementItems.slice(0, 6) : [];
  const violations = resultViolations.map(normalizeViolation);
  const affectedGroups = Array.isArray(result.affectedGroups) ? result.affectedGroups.slice(0, 1) : [];
  const sources = Array.isArray(result.sources) && result.sources.length ? result.sources : fallback.sources;
  const overall = Object.assign({ riskLevel: "낮음", summary: "", reviewBasis: "" }, result.overall || {});
  const userMentalModel = normalizeUserMentalModel(result.userMentalModel || fallback.userMentalModel || {});
  const screenElementMap = normalizeScreenElementMap(result.screenElementMap || fallback.screenElementMap || {});
  if (!["낮음", "보통", "높음"].includes(overall.riskLevel)) {
    overall.riskLevel = rawImprovementItems.length || violations.length ? "보통" : "낮음";
  }
  const improvementItems = normalizeImprovementItems(rawImprovementItems, violations);
  if (!improvementItems.length && !violations.length) overall.riskLevel = "낮음";
  overall.summary = overall.riskLevel === "낮음"
    ? "다크패턴이 검출되지 않았습니다"
    : buildOverallSummary(overall.riskLevel, improvementItems);
  overall.reviewBasis = "";
  const normalized = Object.assign({}, result, {
    frameName: fallback.frameName,
    frameMeta: fallback.frameMeta,
    aiMode: "gemini",
    overall: sanitizeInternalLabels(overall),
    userMentalModel,
    screenElementMap,
    violations: overall.riskLevel === "낮음" ? [] : violations,
    improvementItems: overall.riskLevel === "낮음" ? [] : improvementItems,
    affectedGroups: overall.riskLevel === "낮음" ? [] : affectedGroups.map(normalizeAffectedGroup),
    sources
  });
  delete normalized.dataset;
  return normalized;
}

function normalizeUserMentalModel(value) {
  return sanitizeInternalLabels({
    userGoal: cleanText(value.userGoal || "화면의 핵심 정보를 이해하고 다음 행동을 결정한다."),
    expectedNextAction: cleanText(value.expectedNextAction || "가장 명확한 다음 행동을 선택한다."),
    expectedInformation: cleanText(value.expectedInformation || "결정에 필요한 핵심 조건과 다음 단계"),
    riskIfMissing: cleanText(value.riskIfMissing || "다음 행동의 결과를 오해할 수 있다."),
    normalPath: cleanText(value.normalPath || "중요 정보 확인 후 의도한 행동으로 진행한다.")
  });
}

function normalizeScreenElementMap(value) {
  return sanitizeInternalLabels({
    prominentAction: cleanText(value.prominentAction || ""),
    goalRelatedAction: cleanText(value.goalRelatedAction || ""),
    alternativeAction: cleanText(value.alternativeAction || ""),
    criticalInformation: cleanText(value.criticalInformation || ""),
    costOrCondition: cleanText(value.costOrCondition || ""),
    pressureCopy: cleanText(value.pressureCopy || ""),
    ambiguousCopy: cleanText(value.ambiguousCopy || "")
  });
}

function mergePriorityViolations(fallbackViolations, resultViolations) {
  const merged = [...(fallbackViolations || []), ...(resultViolations || [])];
  const seen = new Set();
  return merged.filter((item) => {
    const key = cleanText(`${item.title || ""}-${item.darkPatternType || ""}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeViolation(item) {
  return sanitizeInternalLabels({
    title: cleanText(item.title || "검토 필요 요소"),
    severity: item.severity === "높음" ? "높음" : "보통",
    darkPatternType: cleanText(item.darkPatternType || "유형 미분류"),
    screenEvidence: cleanText(item.screenEvidence || ""),
    checklistEvidence: cleanText(item.checklistEvidence || ""),
    whyItMatters: cleanText(item.whyItMatters || ""),
    suggestion: cleanText(item.suggestion || "")
  });
}

function normalizeImprovementItems(items, violations) {
  const incomingItems = Array.isArray(items) && items.length ? items : buildImprovementItems(violations);
  const baseItems = dedupeImprovementItems(incomingItems);
  return sanitizeInternalLabels(baseItems.slice(0, 6).map((item, index) => ({
    severity: (item.severity || violations[index]?.severity) === "높음" ? "높음" : "보통",
    area: cleanText(item.area || item.title || "개선 필요 영역"),
    checklist: cleanText(item.checklist || item.darkPatternType || item.checklistEvidence || "검토 필요"),
    reason: removeEllipsis(cleanText(item.reason || item.whyItMatters || item.screenEvidence || "사용자 판단을 어렵게 할 수 있음")),
    fix: cleanText(item.fix || item.suggestion || "문구와 정보 위계를 명확히 조정하세요.")
  })));
}

function dedupeImprovementItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = cleanText(`${item.area || item.title || ""}-${item.checklist || item.darkPatternType || ""}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function removeEllipsis(value) {
  return String(value || "").replace(/…|\.{3}/g, "").trim();
}

function normalizeAffectedGroup(item) {
  const fallbackProfile = profilePlainText(item.userProfile || item.reasonFromPersonaData || item.profile);
  return sanitizeInternalLabels({
    group: cleanText(item.group || "영향받는 사용자 집단"),
    emotion: normalizeInterviewSentence(item.emotion || item.difficulty),
    difficulty: limitTextLines(plainTextValue(item.difficulty || item.emotion), 3),
    reasonFromPersonaData: profilePlainText(item.reasonFromPersonaData || ""),
    userProfile: fallbackProfile,
    personaDetail: plainTextValue(item.personaDetail || item.detail || item.reasonFromPersonaData || fallbackProfile),
    selectionReason: cleanText(item.selectionReason || selectionReasonFromText(item.relatedViolation || item.group)),
    relatedViolation: cleanText(item.relatedViolation || "")
  });
}

function selectionReasonFromText(value) {
  const text = cleanText(value);
  if (/목표|경로|방해|오인|혼란/.test(text)) return "화면 흐름을 오해하기 쉬워 선정됨";
  if (/시간|압박|긴급/.test(text)) return "빠른 선택 압박에 흔들릴 수 있어 선정됨";
  if (/정보|조건|비용|위험/.test(text)) return "중요 조건을 놓치기 쉬워 선정됨";
  if (/동의|선택/.test(text)) return "선택 결과를 오해하기 쉬워 선정됨";
  return "이 화면에서 가장 영향을 받기 쉬워 선정됨";
}

function sanitizeInternalLabels(value) {
  if (Array.isArray(value)) return value.map(sanitizeInternalLabels);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeInternalLabels(item)]));
  }
  if (typeof value !== "string") return value;
  return value
    .replace(/Nemotron-Personas-Korea/gi, "사용자 데이터")
    .replace(/Nemotron/gi, "사용자 데이터")
    .replace(/\bSAMPLE-\d{3}\b/gi, "사용자")
    .replace(/\bNPK-[A-Za-z0-9-]+\b/g, "사용자")
    .replace(/\bfemale\b/gi, "여성")
    .replace(/\bmale\b/gi, "남성")
    .split(/\n+/)
    .map((line) => line.replace(/[ \t\r\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function limitTextLines(value, maxLines) {
  return String(value || "")
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean)
    .slice(0, maxLines)
    .join("\n");
}

function dataUrlToGeminiPart(dataUrl) {
  const match = String(dataUrl || "").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  return {
    inlineData: {
      mimeType: match[1],
      data: match[2]
    }
  };
}

function summarizeGroup(target, selected) {
  const occupations = topValues(selected.map((item) => item.occupation)).join(", ");
  const ages = selected.map((item) => Number(item.age)).filter(Number.isFinite);
  const ageText = ages.length ? `${Math.round(ages.reduce((sum, age) => sum + age, 0) / ages.length)}세 전후` : "연령 혼합";
  return `${target}에 가까운 ${ageText} ${occupations || "한국 합성 페르소나"} 집단`;
}

function topValues(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([value]) => value);
}

function profileSummary(candidate) {
  return `${candidate.age}세 · ${candidate.sex} · ${candidate.province} ${candidate.district} · ${candidate.occupation}`;
}

function candidateText(candidate) {
  return Object.values(candidate).join(" ").toLowerCase();
}

function tokenize(text) {
  return cleanText(text)
    .toLowerCase()
    .split(/[\s,.;:/|()[\]{}"'“”‘’!?]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function cleanText(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, 3000);
}

function sampleCandidates() {
  return [
    sample("SAMPLE-001", 27, "female", "서울특별시", "마포구", "브랜드 마케터", "대학교 졸업", "미혼", "트렌드에 민감하고 인스타그램과 숏폼 콘텐츠를 자주 확인한다.", "뷰티 브랜드 캠페인과 고객 반응 분석을 담당한다.", "러닝과 필라테스를 가볍게 즐긴다.", "전시와 팝업스토어 방문을 좋아한다.", "도쿄와 서울의 편집숍을 탐방하는 여행을 선호한다.", "신상 카페와 건강식 레스토랑을 자주 저장한다.", "가족과는 주말 식사를 챙기는 편이다.", "SNS 콘텐츠 기획, 브랜드 톤앤매너, 소비자 트렌드 리서치", "뷰티, 인스타그램, 팝업스토어, 프리미엄 소비", "브랜드 전략 전문가로 성장하고 싶다.", "서울 도심 라이프스타일과 온라인 커뮤니티 문화에 익숙하다."),
    sample("SAMPLE-002", 31, "female", "경기도", "성남시", "UX 디자이너", "대학교 졸업", "기혼", "새로운 앱과 AI 도구를 빠르게 시험하지만 개인정보 고지는 꼼꼼히 본다.", "금융 앱의 가입 전환과 사용성 개선 프로젝트를 맡고 있다.", "요가와 수영을 한다.", "디자인 시스템과 전시 관람에 관심이 있다.", "휴식형 호캉스와 짧은 해외여행을 선호한다.", "리뷰가 좋은 레스토랑을 신중하게 고른다.", "배우자와 의사결정을 함께 하는 편이다.", "사용성 테스트, 프로토타이핑, 정성 인터뷰", "AI 도구, UX, 뷰티 디바이스, 생산성", "리서치 역량이 강한 프로덕트 디자이너가 되고 싶다.", "수도권 직장인 생활과 디지털 서비스 사용에 능숙하다."),
    sample("SAMPLE-003", 24, "female", "부산광역시", "해운대구", "대학생", "대학교 재학", "미혼", "친구 추천과 SNS 후기에 영향을 많이 받으며 합리적인 가격을 중시한다.", "패션 관련 동아리와 온라인 쇼핑몰 아르바이트 경험이 있다.", "헬스장과 산책을 병행한다.", "K-pop, 메이크업 튜토리얼, 사진 보정에 관심이 많다.", "친구들과 가까운 국내 여행을 즐긴다.", "디저트 카페와 배달 앱을 자주 쓴다.", "부모님과 함께 거주한다.", "콘텐츠 편집, SNS 운영, 고객 응대", "뷰티, 패션, 숏폼, 가성비 쇼핑", "졸업 후 브랜드 커머스 분야에서 일하고 싶다.", "부산 지역 대학가와 온라인 팬덤 문화에 익숙하다."),
    sample("SAMPLE-004", 38, "male", "서울특별시", "강남구", "스타트업 대표", "대학원 졸업", "기혼", "효율과 성과를 중시하며 검증된 AI 서비스에는 비용을 지불한다.", "B2B SaaS 제품을 운영하고 신규 고객 획득 전략을 고민한다.", "골프와 웨이트 트레이닝을 한다.", "비즈니스 도서와 테크 컨퍼런스에 관심이 있다.", "출장과 가족 여행을 모두 챙긴다.", "비즈니스 미팅 장소를 자주 예약한다.", "자녀 교육과 가족 시간을 중요하게 본다.", "사업 개발, 데이터 분석, AI 도입 의사결정", "AI, SaaS, 프리미엄 서비스, 생산성", "회사를 안정적으로 성장시키고 싶다.", "강남권 비즈니스 네트워크와 스타트업 생태계에 익숙하다."),
    sample("SAMPLE-005", 45, "female", "대전광역시", "서구", "초등학교 교사", "대학교 졸업", "기혼", "새로운 서비스는 주변 평판과 안전성을 확인한 뒤 천천히 도입한다.", "학부모 상담과 수업 준비에서 디지털 자료를 활용한다.", "배드민턴을 즐긴다.", "독서 모임과 생활 공예에 관심이 있다.", "가족 중심 국내 여행을 선호한다.", "집밥과 지역 맛집을 함께 챙긴다.", "가족 건강과 안정적인 생활을 중시한다.", "교육 콘텐츠 구성, 커뮤니케이션, 일정 관리", "교육, 건강, 생활 편의, 신뢰 기반 서비스", "학생에게 더 좋은 학습 경험을 제공하고 싶다.", "지역 커뮤니티와 교육 현장 문화에 익숙하다."),
    sample("SAMPLE-006", 29, "male", "인천광역시", "연수구", "영상 크리에이터", "전문대 졸업", "미혼", "새로운 편집 툴과 AI 기능을 빨리 써보고 성능이 좋으면 유료 전환한다.", "브랜드 숏폼 영상과 유튜브 콘텐츠 제작을 병행한다.", "자전거와 클라이밍을 좋아한다.", "카메라, 색보정, 음악 페스티벌에 관심이 많다.", "촬영지를 찾는 여행을 자주 한다.", "야식과 로컬 맛집 탐색을 즐긴다.", "독립 생활 중이다.", "영상 편집, 촬영, 썸네일 제작, 채널 분석", "AI 영상, 숏폼, 장비, 크리에이터 경제", "개인 채널을 키워 독립 수익을 만들고 싶다.", "수도권 크리에이터 네트워크와 온라인 플랫폼 문화에 익숙하다."),
    sample("SAMPLE-007", 52, "male", "광주광역시", "북구", "자영업자", "고등학교 졸업", "기혼", "매출에 도움이 되는 서비스는 관심 있지만 복잡한 가입 절차를 싫어한다.", "동네 음식점을 운영하며 배달 앱과 지역 광고를 활용한다.", "등산을 한다.", "지역 축제와 야구 관람에 관심이 있다.", "가족 단위 여행을 선호한다.", "한식과 제철 식재료에 관심이 많다.", "가족 생계를 책임지는 의식이 강하다.", "매장 운영, 고객 응대, 원가 관리", "소상공인, 광고, 배달 앱, 실용 서비스", "단골 고객을 늘리고 운영 부담을 줄이고 싶다.", "지역 상권과 오프라인 고객 관계에 익숙하다."),
    sample("SAMPLE-008", 34, "female", "제주특별자치도", "제주시", "프리랜서 번역가", "대학교 졸업", "미혼", "혼자 비교 검토한 뒤 선택하며 구독 서비스 피로도가 있다.", "관광, 문화, IT 문서 번역을 맡는다.", "러닝과 홈트레이닝을 한다.", "독립 출판과 사진에 관심이 있다.", "장기 체류형 여행과 로컬 경험을 선호한다.", "로컬 식재료와 비건 옵션을 살핀다.", "반려 생활과 개인 시간을 중시한다.", "번역, 리서치, 일정 관리, 외국어 커뮤니케이션", "여행, 언어, 생산성, 웰니스", "안정적인 장기 클라이언트를 확보하고 싶다.", "제주 로컬 커뮤니티와 원격 근무 문화에 익숙하다.")
  ];
}

function sample(id, age, sex, province, district, occupation, education, maritalStatus, persona, professionalPersona, sportsPersona, artsPersona, travelPersona, culinaryPersona, familyPersona, skillsAndExpertise, hobbiesAndInterests, careerGoals, culturalBackground) {
  return {
    id,
    age,
    sex,
    province,
    district,
    occupation,
    education,
    maritalStatus,
    persona,
    professionalPersona,
    sportsPersona,
    artsPersona,
    travelPersona,
    culinaryPersona,
    familyPersona,
    skillsAndExpertise,
    hobbiesAndInterests,
    careerGoals,
    culturalBackground
  };
}
