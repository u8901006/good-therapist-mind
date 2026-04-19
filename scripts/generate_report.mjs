import { readFile, writeFile, mkdir } from "fs/promises";
import { resolve, dirname } from "path";

const API_BASE = process.env.ZHIPU_API_BASE || "https://open.bigmodel.cn/api/coding/paas/v4";
const MODELS = ["GLM-5-Turbo", "GLM-4.7", "GLM-4.7-Flash"];

const SYSTEM_PROMPT = `你是心理治療與諮商研究領域的專業摘要分析師。你的任務是：
1. 從論文摘要中提煉出最具有臨床實用價值的精華
2. 每篇摘要需包含中文標題翻譯、一句話總結、PICO 分析
3. 評估臨床實用性（高/中/低）
4. 生成適合臨床工作者閱讀的摘要

輸出格式要求：
- 語言：中文（台灣用語）
- 準確翻譯專業術語
- 每篇摘要須包含：中文標題、一句話總結、PICO分析、臨床實用性、關鍵標籤
- 最後提供今日 TOP 5-8 篇精選（按重要性排序）
- 回傳格式必須是純 JSON，不要用 markdown code block 包裹。`;

function buildPrompt(papersData) {
  const dateStr = papersData.date;
  const count = papersData.count;
  const papersText = JSON.stringify(papersData.papers, null, 2);

  return `以下是 ${dateStr} 從 PubMed 抓取的最新心理治療與諮商研究文獻（共 ${count} 篇）。

請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block 包裹）：

{
  "date": "${dateStr}",
  "market_summary": "1-2句總結今日文獻趨勢與亮點",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結（中文，點出核心發現與臨床意涵）",
      "pico": {
        "population": "研究對象",
        "intervention": "介入措施",
        "comparison": "對照組",
        "outcome": "主要結果"
      },
      "clinical_utility": "高/中/低",
      "utility_reason": "為何實用的一句話說明",
      "tags": ["標籤1", "標籤2"],
      "url": "連結",
      "emoji": "一個emoji"
    }
  ],
  "all_papers": [
    {
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結",
      "clinical_utility": "高/中/低",
      "tags": ["標籤1"],
      "url": "連結",
      "emoji": "emoji"
    }
  ],
  "keywords": ["關鍵詞1", "關鍵詞2"],
  "topic_distribution": {
    "治療聯盟": 3,
    "同理心": 2
  }
}

原始文獻資料：
${papersText}

請挑選出最重要的 TOP 5-8 篇放入 top_picks（按重要性排序），其餘放入 all_papers。
每篇 paper 的 tags 請從以下選擇：治療聯盟、同理心、治療師發展、督導、共同因素、心理治療歷程、情緒調節、依附、心智化、文化能力、動機式訪談、認知行為治療、家族治療、伴侶治療、正念、創傷治療、物質使用、兒少心理、衡鑑與評估、醫病溝通、脱落與留存、證據實務、神經科學。
注意：回傳純 JSON，不要用 \`\`\`json\`\`\` 包裹。`;
}

function stripJsonBlock(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  return cleaned.trim();
}

function robustJsonParse(text) {
  const cleaned = stripJsonBlock(text);
  try {
    return JSON.parse(cleaned);
  } catch (e1) {
    console.error(`[WARN] Initial JSON parse failed: ${e1.message}`);
  }

  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    const substr = cleaned.slice(jsonStart, jsonEnd + 1);
    try {
      return JSON.parse(substr);
    } catch (e2) {
      console.error(`[WARN] Substring JSON parse failed: ${e2.message}`);
    }
  }

  let fixed = cleaned;
  fixed = fixed.replace(/,\s*([}\]])/g, "$1");
  fixed = fixed.replace(/"\s*\n\s*"/g, '"\n"');
  fixed = fixed.replace(/\}\s*\{/g, "},{");
  try {
    return JSON.parse(fixed);
  } catch (e3) {
    console.error(`[WARN] Fixed JSON parse failed: ${e3.message}`);
  }

  try {
    const balanced = fixBrackets(fixed);
    return JSON.parse(balanced);
  } catch (e4) {
    console.error(`[WARN] Balanced JSON parse failed: ${e4.message}`);
  }

  return null;
}

function fixBrackets(str) {
  let result = str;
  const opens = (result.match(/{/g) || []).length;
  const closes = (result.match(/}/g) || []).length;
  if (opens > closes) result += "}".repeat(opens - closes);
  const openArr = (result.match(/\[/g) || []).length;
  const closeArr = (result.match(/]/g) || []).length;
  if (openArr > closeArr) result += "]".repeat(openArr - closeArr);
  return result;
}

async function callZhipuAPI(apiKey, prompt, modelIndex = 0) {
  if (modelIndex >= MODELS.length) return null;

  const model = MODELS[modelIndex];
  console.error(`[INFO] Trying model: ${model}`);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      console.error(`[INFO] Attempt ${attempt + 1}/3 for ${model}...`);
      const resp = await fetch(`${API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          top_p: 0.9,
          max_tokens: 100000,
        }),
        signal: AbortSignal.timeout(660000),
      });

      if (resp.status === 429) {
        const wait = 60 * (attempt + 1);
        console.error(`[WARN] Rate limited, waiting ${wait}s...`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        console.error(`[ERROR] HTTP ${resp.status}: ${body.slice(0, 200)}`);
        if (resp.status >= 500) continue;
        break;
      }

      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content || "";
      if (!content) {
        console.error("[WARN] Empty response content");
        continue;
      }

      const parsed = robustJsonParse(content);
      if (parsed) {
        console.error(
          `[INFO] Analysis complete: ${parsed.top_picks?.length || 0} top picks, ${parsed.all_papers?.length || 0} total`
        );
        return parsed;
      }

      console.error(`[WARN] JSON parse failed on attempt ${attempt + 1}, retrying...`);
      await new Promise((r) => setTimeout(r, 5000));
    } catch (e) {
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        console.error(`[WARN] Request timeout on attempt ${attempt + 1}`);
      } else {
        console.error(`[ERROR] ${model} failed: ${e.message}`);
      }
    }
  }

  console.error(`[WARN] Model ${model} failed all attempts, trying fallback...`);
  return callZhipuAPI(apiKey, prompt, modelIndex + 1);
}

function generateHtml(analysis) {
  const dateStr = analysis.date || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const parts = dateStr.split("-");
  const dateDisplay = parts.length === 3 ? `${parts[0]}年${parseInt(parts[1])}月${parseInt(parts[2])}日` : dateStr;

  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  const wd = parts.length === 3 ? weekdays[new Date(dateStr).getDay()] : "";

  const summary = analysis.market_summary || "";
  const topPicks = analysis.top_picks || [];
  const allPapers = analysis.all_papers || [];
  const keywords = analysis.keywords || [];
  const topicDist = analysis.topic_distribution || {};
  const totalCount = topPicks.length + allPapers.length;

  let topPicksHtml = "";
  for (const pick of topPicks) {
    const tags = (pick.tags || []).map((t) => `<span class="tag">${t}</span>`).join("");
    const util = pick.clinical_utility || "中";
    const uc = util === "高" ? "utility-high" : util === "中" ? "utility-mid" : "utility-low";
    const pico = pick.pico || {};
    const picoHtml = Object.keys(pico).length
      ? `<div class="pico-grid">
      <div class="pico-item"><span class="pico-label">P</span><span class="pico-text">${pico.population || "-"}</span></div>
      <div class="pico-item"><span class="pico-label">I</span><span class="pico-text">${pico.intervention || "-"}</span></div>
      <div class="pico-item"><span class="pico-label">C</span><span class="pico-text">${pico.comparison || "-"}</span></div>
      <div class="pico-item"><span class="pico-label">O</span><span class="pico-text">${pico.outcome || "-"}</span></div>
    </div>`
      : "";

    topPicksHtml += `
    <div class="news-card featured">
      <div class="card-header">
        <span class="rank-badge">#${pick.rank || ""}</span>
        <span class="emoji-icon">${pick.emoji || "📄"}</span>
        <span class="${uc}">${util}實用性</span>
      </div>
      <h3>${pick.title_zh || pick.title_en || ""}</h3>
      <p class="journal-source">${pick.journal || ""} &middot; ${pick.title_en || ""}</p>
      <p>${pick.summary || ""}</p>
      ${picoHtml}
      <div class="card-footer">
        ${tags}
        <a href="${pick.url || "#"}" target="_blank">閱讀原文 →</a>
      </div>
    </div>`;
  }

  let allPapersHtml = "";
  for (const paper of allPapers) {
    const tags = (paper.tags || []).map((t) => `<span class="tag">${t}</span>`).join("");
    const util = paper.clinical_utility || "中";
    const uc = util === "高" ? "utility-high" : util === "中" ? "utility-mid" : "utility-low";
    allPapersHtml += `
    <div class="news-card">
      <div class="card-header-row">
        <span class="emoji-sm">${paper.emoji || "📄"}</span>
        <span class="${uc} utility-sm">${util}</span>
      </div>
      <h3>${paper.title_zh || paper.title_en || ""}</h3>
      <p class="journal-source">${paper.journal || ""}</p>
      <p>${paper.summary || ""}</p>
      <div class="card-footer">
        ${tags}
        <a href="${paper.url || "#"}" target="_blank">PubMed →</a>
      </div>
    </div>`;
  }

  const keywordsHtml = keywords.map((k) => `<span class="keyword">${k}</span>`).join("");
  let topicBarsHtml = "";
  if (Object.keys(topicDist).length) {
    const maxCount = Math.max(...Object.values(topicDist), 1);
    for (const [topic, count] of Object.entries(topicDist)) {
      const w = Math.round((count / maxCount) * 100);
      topicBarsHtml += `
      <div class="topic-row">
        <span class="topic-name">${topic}</span>
        <div class="topic-bar-bg"><div class="topic-bar" style="width:${w}%"></div></div>
        <span class="topic-count">${count}</span>
      </div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Good Therapist Mind &middot; 心理治療文獻日報 &middot; ${dateDisplay}</title>
<meta name="description" content="${dateDisplay} 心理治療文獻日報，由 AI 自動彙整 PubMed 最新論文"/>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; --card-bg: color-mix(in srgb, var(--surface) 92%, white); }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; overflow-x: hidden; }
  .container { position: relative; z-index: 1; max-width: 880px; margin: 0 auto; padding: 60px 32px 80px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 52px; animation: fadeDown 0.6s ease both; }
  .logo { width: 48px; height: 48px; border-radius: 14px; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; box-shadow: 0 4px 20px rgba(140,79,43,0.25); }
  .header-text h1 { font-size: 22px; font-weight: 700; color: var(--text); letter-spacing: -0.3px; }
  .header-meta { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; letter-spacing: 0.3px; }
  .badge-date { background: var(--accent-soft); border: 1px solid var(--line); color: var(--accent); }
  .badge-count { background: rgba(140,79,43,0.06); border: 1px solid var(--line); color: var(--muted); }
  .badge-source { background: transparent; color: var(--muted); font-size: 11px; padding: 0 4px; }
  .summary-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 28px 32px; margin-bottom: 32px; box-shadow: 0 20px 60px rgba(61,36,15,0.06); animation: fadeUp 0.5s ease 0.1s both; }
  .summary-card h2 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.6px; color: var(--accent); margin-bottom: 16px; }
  .summary-text { font-size: 15px; line-height: 1.8; color: var(--text); }
  .section { margin-bottom: 36px; animation: fadeUp 0.5s ease both; }
  .section-title { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .section-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; background: var(--accent-soft); }
  .news-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 22px 26px; margin-bottom: 12px; box-shadow: 0 8px 30px rgba(61,36,15,0.04); transition: background 0.2s, border-color 0.2s, transform 0.2s; }
  .news-card:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .news-card.featured { border-left: 3px solid var(--accent); }
  .news-card.featured:hover { border-color: var(--accent); }
  .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .rank-badge { background: var(--accent); color: #fff7f0; font-weight: 700; font-size: 12px; padding: 2px 8px; border-radius: 6px; }
  .emoji-icon { font-size: 18px; }
  .card-header-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .emoji-sm { font-size: 14px; }
  .news-card h3 { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 8px; line-height: 1.5; }
  .journal-source { font-size: 12px; color: var(--accent); margin-bottom: 8px; opacity: 0.8; }
  .news-card p { font-size: 13.5px; line-height: 1.75; color: var(--muted); }
  .card-footer { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag { padding: 2px 9px; background: var(--accent-soft); border-radius: 999px; font-size: 11px; color: var(--accent); }
  .news-card a { font-size: 12px; color: var(--accent); text-decoration: none; opacity: 0.7; margin-left: auto; }
  .news-card a:hover { opacity: 1; }
  .utility-high { color: #5a7a3a; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(90,122,58,0.1); border-radius: 4px; }
  .utility-mid { color: #9f7a2e; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(159,122,46,0.1); border-radius: 4px; }
  .utility-low { color: var(--muted); font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(118,100,83,0.08); border-radius: 4px; }
  .utility-sm { font-size: 10px; }
  .pico-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; padding: 12px; background: rgba(255,253,249,0.8); border-radius: 14px; border: 1px solid var(--line); }
  .pico-item { display: flex; gap: 8px; align-items: baseline; }
  .pico-label { font-size: 10px; font-weight: 700; color: #fff7f0; background: var(--accent); padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
  .pico-text { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .keywords-section { margin-bottom: 36px; }
  .keywords { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .keyword { padding: 5px 14px; background: var(--accent-soft); border: 1px solid var(--line); border-radius: 20px; font-size: 12px; color: var(--accent); cursor: default; transition: background 0.2s; }
  .keyword:hover { background: rgba(140,79,43,0.18); }
  .topic-section { margin-bottom: 36px; }
  .topic-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .topic-name { font-size: 13px; color: var(--muted); width: 100px; flex-shrink: 0; text-align: right; }
  .topic-bar-bg { flex: 1; height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .topic-bar { height: 100%; background: linear-gradient(90deg, var(--accent), #c47a4a); border-radius: 4px; transition: width 0.6s ease; }
  .topic-count { font-size: 12px; color: var(--accent); width: 24px; }
  .footer-links { margin-top: 48px; display: flex; flex-direction: column; gap: 12px; animation: fadeUp 0.5s ease 0.3s both; }
  .footer-link-card { display: flex; align-items: center; gap: 14px; padding: 18px 24px; background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; text-decoration: none; color: var(--text); transition: all 0.2s; box-shadow: 0 8px 30px rgba(61,36,15,0.04); }
  .footer-link-card:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .footer-link-icon { font-size: 28px; flex-shrink: 0; }
  .footer-link-text { font-size: 15px; font-weight: 700; color: var(--text); flex: 1; }
  .footer-link-arrow { font-size: 18px; color: var(--accent); font-weight: 700; }
  footer { margin-top: 32px; padding-top: 22px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; animation: fadeUp 0.5s ease 0.5s both; }
  footer a { color: var(--muted); text-decoration: none; }
  footer a:hover { color: var(--accent); }
  @keyframes fadeDown { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 600px) { .container { padding: 36px 18px 60px; } .summary-card, .news-card { padding: 20px 18px; } .pico-grid { grid-template-columns: 1fr; } footer { flex-direction: column; gap: 6px; text-align: center; } .topic-name { width: 70px; font-size: 11px; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">🤝</div>
    <div class="header-text">
      <h1>Good Therapist Mind &middot; 心理治療文獻日報</h1>
      <div class="header-meta">
        <span class="badge badge-date">📅 ${dateDisplay}（週${wd}）</span>
        <span class="badge badge-count">📊 ${totalCount} 篇文獻</span>
        <span class="badge badge-source">Powered by PubMed + Zhipu AI</span>
      </div>
    </div>
  </header>

  ${summary ? `<div class="summary-card">
    <h2>📋 今日文獻趨勢</h2>
    <p class="summary-text">${summary}</p>
  </div>` : ""}

  ${topPicksHtml ? `<div class='section'><div class='section-title'><span class='section-icon'>⭐</span>今日精選 TOP Picks</div>${topPicksHtml}</div>` : ""}

  ${allPapersHtml ? `<div class='section'><div class='section-title'><span class='section-icon'>📚</span>其他值得關注的文獻</div>${allPapersHtml}</div>` : ""}

  ${topicBarsHtml ? `<div class='topic-section section'><div class='section-title'><span class='section-icon'>📊</span>主題分佈</div>${topicBarsHtml}</div>` : ""}

  ${keywordsHtml ? `<div class='keywords-section section'><div class='section-title'><span class='section-icon'>🏷️</span>關鍵字</div><div class='keywords'>${keywordsHtml}</div></div>` : ""}

  <div class="footer-links">
    <a href="https://www.leepsyclinic.com/" class="footer-link-card" target="_blank">
      <span class="footer-link-icon">🏥</span>
      <span class="footer-link-text">李政洋身心診所首頁</span>
      <span class="footer-link-arrow">→</span>
    </a>
    <a href="https://blog.leepsyclinic.com/" class="footer-link-card" target="_blank">
      <span class="footer-link-icon">📧</span>
      <span class="footer-link-text">訂閱電子報</span>
      <span class="footer-link-arrow">→</span>
    </a>
    <a href="https://buymeacoffee.com/CYlee" class="footer-link-card" target="_blank">
      <span class="footer-link-icon">☕</span>
      <span class="footer-link-text">Buy Me a Coffee</span>
      <span class="footer-link-arrow">→</span>
    </a>
  </div>

  <footer>
    <span>資料來源：PubMed &middot; 分析模型：${MODELS[0]}</span>
    <span><a href="https://github.com/u8901006/good-therapist-mind">GitHub</a></span>
  </footer>
</div>
</body>
</html>`;
}

async function main() {
  const args = process.argv.slice(2);
  const getInput = () => args.find((a) => a.startsWith("--input="))?.split("=")[1] || "papers.json";
  const getOutput = () => args.find((a) => a.startsWith("--output="))?.split("=")[1];
  const getApiKey = () => args.find((a) => a.startsWith("--api-key="))?.split("=")[1] || process.env.ZHIPU_API_KEY || "";

  const inputPath = getInput();
  const apiKey = getApiKey();

  if (!apiKey) {
    console.error("[ERROR] No API key. Set ZHIPU_API_KEY env var or use --api-key=");
    process.exit(1);
  }

  const papersData = JSON.parse(await readFile(inputPath, "utf-8"));

  let analysis;
  if (!papersData.papers?.length) {
    console.error("[WARN] No papers found, generating empty report");
    analysis = {
      date: papersData.date || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
      market_summary: "今日 PubMed 暫無新的心理治療研究文獻更新。請明天再查看。",
      top_picks: [],
      all_papers: [],
      keywords: [],
      topic_distribution: {},
    };
  } else {
    const prompt = buildPrompt(papersData);
    analysis = await callZhipuAPI(apiKey, prompt);
    if (!analysis) {
      console.error("[ERROR] Analysis failed");
      process.exit(1);
    }
  }

  const html = generateHtml(analysis);

  let outputPath = getOutput();
  if (!outputPath) {
    outputPath = `docs/therapy-${analysis.date}.html`;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf-8");
  console.error(`[INFO] Report saved to ${outputPath}`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
