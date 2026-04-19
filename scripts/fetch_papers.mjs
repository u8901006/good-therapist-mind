import { XMLParser } from "fast-xml-parser";

const PUBMED_SEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_FETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

const JOURNALS = [
  "Psychotherapy",
  "Psychotherapy Research",
  "Psychotherapy and Psychosomatics",
  "Clinical Psychology & Psychotherapy",
  "Research in Psychotherapy",
  "Journal of Contemporary Psychotherapy",
  "Behavior Therapy",
  "Cognitive Therapy and Research",
  "Cognitive and Behavioral Practice",
  "Journal of Consulting and Clinical Psychology",
  "Journal of Counseling Psychology",
  "The Counseling Psychologist",
  "Professional Psychology: Research and Practice",
  "Clinical Psychology: Science and Practice",
  "Journal of Clinical Psychology",
  "Patient Education and Counseling",
  "World Psychiatry",
  "American Journal of Psychiatry",
  "JAMA Psychiatry",
  "Frontiers in Psychology",
  "Social Cognitive and Affective Neuroscience",
  "Neuroscience and Biobehavioral Reviews",
  "Family Process",
  "Journal of Marital and Family Therapy",
];

const TOPIC_CLUSTERS = [
  `"therapeutic alliance" OR "working alliance"`,
  `empathy OR compassion OR attunement`,
  `"therapist effects" OR "therapist variability"`,
  `"common factors" OR "psychotherapy process"`,
  `"rupture repair" OR "therapeutic relationship"`,
  `"deliberate practice" OR "therapist competence"`,
  `supervision OR "therapist development"`,
  `"feedback informed treatment" OR "routine outcome monitoring"`,
  `mentalization OR "reflective functioning"`,
  `"emotion regulation" OR attachment`,
  `"cultural humility" OR "multicultural competence"`,
  `"case formulation" OR "case conceptualization"`,
  `"motivational interviewing" OR "patient centered communication"`,
  `"mechanisms of change" OR "treatment outcome"`,
  `dropout OR "premature termination" OR engagement`,
];

function buildQueries(days) {
  const since = new Date(Date.now() - days * 86400000);
  const y = since.getFullYear();
  const m = String(since.getMonth() + 1).padStart(2, "0");
  const d = String(since.getDate()).padStart(2, "0");
  const dateFilter = `"${y}/${m}/${d}"[Date - Publication] : "3000"[Date - Publication]`;

  const queries = [];
  const journalPart = JOURNALS.map((j) => `"${j}"[Journal]`).join(" OR ");

  for (const topic of TOPIC_CLUSTERS) {
    queries.push(`(${journalPart}) AND (${topic}) AND ${dateFilter}`);
  }

  return queries;
}

async function pubmedSearch(query, retmax = 20) {
  const url = `${PUBMED_SEARCH}?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&sort=date&retmode=json`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "GoodTherapistMind/1.0" },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`PubMed search HTTP ${resp.status}`);
  const data = await resp.json();
  return data.esearchresult?.idlist || [];
}

async function pubmedFetch(pmids) {
  if (!pmids.length) return [];
  const url = `${PUBMED_FETCH}?db=pubmed&id=${pmids.join(",")}&retmode=xml`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "GoodTherapistMind/1.0" },
        signal: AbortSignal.timeout(60000),
      });
      if (resp.status === 429) {
        const wait = 30 * (attempt + 1);
        console.error(`[WARN] Fetch rate limited, waiting ${wait}s...`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (!resp.ok) throw new Error(`PubMed fetch HTTP ${resp.status}`);
      const xml = await resp.text();

      const parser = new XMLParser({
        ignoreAttributes: false,
        isArray: (name) => ["PubmedArticle", "AbstractText", "Keyword"].includes(name),
      });
      const root = parser.parse(xml);
      const articles = root?.PubmedArticleSet?.PubmedArticle || [];
      const papers = [];

      for (const article of articles) {
        const medline = article.MedlineCitation;
        if (!medline) continue;
        const art = medline.Article;
        if (!art) continue;

        const title = art.ArticleTitle || "";
        const journal = art.Journal?.Title || "";

        let abstract = "";
        const absTexts = art.Abstract?.AbstractText;
        if (Array.isArray(absTexts)) {
          abstract = absTexts
            .map((a) => {
              const label = a["@_Label"];
              const text = typeof a === "string" ? a : a["#text"] || "";
              return label ? `${label}: ${text}` : text;
            })
            .join(" ")
            .slice(0, 2000);
        }

        const pmid = String(medline.PMID?.["#text"] || medline.PMID || "");
        const keywords = [];
        const kwList = medline.KeywordList;
        if (kwList) {
          const kws = Array.isArray(kwList) ? kwList : [kwList];
          for (const kl of kws) {
            const items = kl.Keyword;
            if (Array.isArray(items)) {
              for (const kw of items) {
                const t = typeof kw === "string" ? kw : kw["#text"];
                if (t) keywords.push(t.trim());
              }
            }
          }
        }

        const pubDate = art.Journal?.JournalIssue?.PubDate;
        const dateParts = [pubDate?.Year, pubDate?.Month, pubDate?.Day].filter(Boolean);
        const dateStr = dateParts.join(" ");

        papers.push({
          pmid,
          title: title.slice(0, 500),
          journal,
          date: dateStr,
          abstract,
          url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "",
          keywords,
        });
      }

      return papers;
    } catch (e) {
      console.error(`[WARN] Fetch attempt ${attempt + 1} failed: ${e.message}`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 5000));
    }
  }
  return [];
}

async function loadExistingPmids(docsDir) {
  const { readdir, readFile } = await import("fs/promises");
  const path = await import("path");
  const pmids = new Set();
  try {
    const files = await readdir(docsDir);
    const htmlFiles = files.filter((f) => f.startsWith("therapy-") && f.endsWith(".html"));
    for (const f of htmlFiles) {
      try {
        const content = await readFile(path.join(docsDir, f), "utf-8");
        const matches = content.matchAll(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/g);
        for (const m of matches) pmids.add(m[1]);
      } catch {}
    }
  } catch {}
  return pmids;
}

async function main() {
  const days = parseInt(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] || "7");
  const maxPapers = parseInt(process.argv.find((a) => a.startsWith("--max-papers="))?.split("=")[1] || "40");
  const output = process.argv.find((a) => a.startsWith("--output="))?.split("=")[1] || "papers.json";
  const docsDir = process.argv.find((a) => a.startsWith("--docs="))?.split("=")[1] || "docs";

  const queries = buildQueries(days);
  console.error(`[INFO] Built ${queries.length} queries, looking back ${days} days`);

  const allPmids = new Set();
  for (let i = 0; i < queries.length; i++) {
    try {
      const ids = await pubmedSearch(queries[i], 15);
      for (const id of ids) allPmids.add(id);
    } catch (e) {
      console.error(`[WARN] Query ${i + 1}/${queries.length} failed: ${e.message}`);
    }
    if (i < queries.length - 1) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  console.error(`[INFO] Found ${allPmids.size} unique PMIDs`);

  const existingPmids = await loadExistingPmids(docsDir);
  const newPmids = [...allPmids].filter((id) => !existingPmids.has(id)).slice(0, maxPapers);
  console.error(`[INFO] After dedup: ${newPmids.length} new papers (${existingPmids.size} already in reports)`);

  if (!newPmids.length) {
    console.error("[INFO] No new papers found");
    const result = {
      date: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
      count: 0,
      papers: [],
    };
    const { writeFile } = await import("fs/promises");
    await writeFile(output, JSON.stringify(result, null, 2), "utf-8");
    return;
  }

  const batchSize = 20;
  let allPapers = [];
  for (let i = 0; i < newPmids.length; i += batchSize) {
    const batch = newPmids.slice(i, i + batchSize);
    if (i > 0) await new Promise((r) => setTimeout(r, 5000));
    try {
      const papers = await pubmedFetch(batch);
      allPapers.push(...papers);
    } catch (e) {
      console.error(`[WARN] Fetch batch failed: ${e.message}`);
    }
  }

  console.error(`[INFO] Fetched ${allPapers.length} paper details`);

  const result = {
    date: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
    count: allPapers.length,
    papers: allPapers,
  };

  const { writeFile } = await import("fs/promises");
  await writeFile(output, JSON.stringify(result, null, 2), "utf-8");
  console.error(`[INFO] Saved to ${output}`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
