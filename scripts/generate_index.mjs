import { readdir, writeFile } from "fs/promises";

const weekdays = ["日", "一", "二", "三", "四", "五", "六"];

async function main() {
  const docsDir = process.argv.find((a) => a.startsWith("--docs="))?.split("=")[1] || "docs";

  let files = [];
  try {
    const all = await readdir(docsDir);
    files = all.filter((f) => f.startsWith("therapy-") && f.endsWith(".html")).sort().reverse();
  } catch {}

  let links = "";
  let count = 0;
  for (const f of files.slice(0, 30)) {
    const dateStr = f.replace("therapy-", "").replace(".html", "");
    let dateDisplay = dateStr;
    let wd = "";
    try {
      const d = new Date(dateStr);
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      const day = d.getDate();
      dateDisplay = `${y}年${m}月${day}日`;
      wd = `（週${weekdays[d.getDay()]}）`;
    } catch {}
    links += `<li><a href="${f}">📅 ${dateDisplay}${wd}</a></li>\n`;
    count++;
  }

  const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Good Therapist Mind &middot; 心理治療文獻日報</title>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; }
  .container { position: relative; z-index: 1; max-width: 640px; margin: 0 auto; padding: 80px 24px; }
  .logo { font-size: 48px; text-align: center; margin-bottom: 16px; }
  h1 { text-align: center; font-size: 24px; color: var(--text); margin-bottom: 8px; }
  .subtitle { text-align: center; color: var(--accent); font-size: 14px; margin-bottom: 48px; }
  .count { text-align: center; color: var(--muted); font-size: 13px; margin-bottom: 32px; }
  ul { list-style: none; }
  li { margin-bottom: 8px; }
  a { color: var(--text); text-decoration: none; display: block; padding: 14px 20px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; transition: all 0.2s; font-size: 15px; }
  a:hover { background: var(--accent-soft); border-color: var(--accent); transform: translateX(4px); }
  .footer-links { margin-top: 48px; display: flex; flex-direction: column; gap: 12px; }
  .footer-link-card { display: flex; align-items: center; gap: 14px; padding: 18px 24px; background: var(--surface); border: 1px solid var(--line); border-radius: 24px; text-decoration: none; color: var(--text); transition: all 0.2s; box-shadow: 0 8px 30px rgba(61,36,15,0.04); }
  .footer-link-card:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .footer-link-icon { font-size: 28px; flex-shrink: 0; }
  .footer-link-text { font-size: 15px; font-weight: 700; color: var(--text); flex: 1; }
  .footer-link-arrow { font-size: 18px; color: var(--accent); font-weight: 700; }
  footer { margin-top: 56px; text-align: center; font-size: 12px; color: var(--muted); }
  footer a { display: inline; padding: 0; background: none; border: none; color: var(--muted); }
  footer a:hover { color: var(--accent); }
</style>
</head>
<body>
<div class="container">
  <div class="logo">🤝</div>
  <h1>Good Therapist Mind</h1>
  <p class="subtitle">心理治療文獻日報 · 每日自動更新</p>
  <p class="count">共 ${count} 期日報</p>
  <ul>${links}</ul>
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
    <p>Powered by PubMed + Zhipu AI · <a href="https://github.com/u8901006/good-therapist-mind">GitHub</a></p>
  </footer>
</div>
</body>
</html>`;

  const outPath = `${docsDir}/index.html`;
  await writeFile(outPath, html, "utf-8");
  console.error(`[INFO] Index page generated: ${outPath}`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
