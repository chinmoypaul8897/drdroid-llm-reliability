import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import OpenAI from "openai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT_FILE = path.join(__dirname, "results-raw.json");
const OUTPUT_FILE = path.join(__dirname, "results.json");

const JUDGE_MODEL = process.env.JUDGE_MODEL || "gpt-4o-mini";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type ModelRun = {
  model: string;
  response: string;
  input_tokens: number;
  output_tokens: number;
  first_token_ms: number | null;
  total_duration_ms: number;
  tokens_per_second: number;
  cost_usd: number;
  error: string | null;
};

type PromptResult = {
  id: string;
  category: string;
  prompt: string;
  oss: ModelRun;
  commercial: ModelRun;
};

type QualityScore = {
  accuracy: number;
  completeness: number;
  clarity: number;
  total: number;
  reasoning: string;
};

type JudgedResult = PromptResult & {
  oss_score: QualityScore;
  commercial_score: QualityScore;
  judge_bias_disclosed: boolean;
};

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const JUDGE_SYSTEM_PROMPT = `You are an impartial AI judge evaluating two responses to the same prompt.
Score each response on three dimensions, each on a 1-5 scale:
- accuracy: Is the content factually correct?
- completeness: Does it address all parts of the prompt?
- clarity: Is it well-structured and readable?

Return ONLY valid JSON in this exact shape, nothing else:
{
  "response_a": { "accuracy": <1-5>, "completeness": <1-5>, "clarity": <1-5>, "reasoning": "<one sentence>" },
  "response_b": { "accuracy": <1-5>, "completeness": <1-5>, "clarity": <1-5>, "reasoning": "<one sentence>" }
}

Be fair and rigorous. Do not favor longer responses over correct ones. Do not favor a response just because it appears first.`;

function buildJudgeUserPrompt(prompt: string, a: string, b: string): string {
  return `Prompt the responses are answering:
"""
${prompt}
"""

Response A:
"""
${a}
"""

Response B:
"""
${b}
"""

Score each response and return the JSON object as specified.`;
}

async function judgePair(
  prompt: string,
  ossResp: string,
  commResp: string
): Promise<{ oss: QualityScore; commercial: QualityScore }> {
  // Randomize position to prevent position bias
  const ossIsA = Math.random() < 0.5;
  const responseA = ossIsA ? ossResp : commResp;
  const responseB = ossIsA ? commResp : ossResp;

  const completion = await openai.chat.completions.create({
    model: JUDGE_MODEL,
    messages: [
      { role: "system", content: JUDGE_SYSTEM_PROMPT },
      { role: "user", content: buildJudgeUserPrompt(prompt, responseA, responseB) },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Judge returned empty content");

  const parsed = JSON.parse(content);
  const a = parsed.response_a;
  const b = parsed.response_b;

  if (!a || !b) throw new Error("Judge returned malformed JSON: " + content.slice(0, 200));

  const scoreA: QualityScore = {
    accuracy: Number(a.accuracy),
    completeness: Number(a.completeness),
    clarity: Number(a.clarity),
    total: Number(a.accuracy) + Number(a.completeness) + Number(a.clarity),
    reasoning: String(a.reasoning || ""),
  };
  const scoreB: QualityScore = {
    accuracy: Number(b.accuracy),
    completeness: Number(b.completeness),
    clarity: Number(b.clarity),
    total: Number(b.accuracy) + Number(b.completeness) + Number(b.clarity),
    reasoning: String(b.reasoning || ""),
  };

  // Unshuffle
  return {
    oss: ossIsA ? scoreA : scoreB,
    commercial: ossIsA ? scoreB : scoreA,
  };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("ERROR: OPENAI_API_KEY not set. Check .env file.");
    process.exit(1);
  }

  log("Loading raw results...");
  const raw = fs.readFileSync(INPUT_FILE, "utf-8");
  const results = JSON.parse(raw) as PromptResult[];
  log(`Loaded ${results.length} results. Judging with ${JUDGE_MODEL}...`);

  const judged: JudgedResult[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    log(`(${i + 1}/${results.length}) Judging ${r.id}...`);

    if (r.oss.error || r.commercial.error) {
      log(`  Skipping (had error in benchmark run)`);
      judged.push({
        ...r,
        oss_score: { accuracy: 0, completeness: 0, clarity: 0, total: 0, reasoning: "benchmark error, not scored" },
        commercial_score: { accuracy: 0, completeness: 0, clarity: 0, total: 0, reasoning: "benchmark error, not scored" },
        judge_bias_disclosed: true,
      });
      continue;
    }

    try {
      const { oss, commercial } = await judgePair(r.prompt, r.oss.response, r.commercial.response);
      log(`  OSS: ${oss.total}/15 | Commercial: ${commercial.total}/15`);
      judged.push({
        ...r,
        oss_score: oss,
        commercial_score: commercial,
        judge_bias_disclosed: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ERROR: ${msg}`);
      judged.push({
        ...r,
        oss_score: { accuracy: 0, completeness: 0, clarity: 0, total: 0, reasoning: `judge error: ${msg}` },
        commercial_score: { accuracy: 0, completeness: 0, clarity: 0, total: 0, reasoning: `judge error: ${msg}` },
        judge_bias_disclosed: true,
      });
    }

    // Incremental save
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(judged, null, 2), "utf-8");
  }

  log(`All done. Wrote ${OUTPUT_FILE}`);

  // Summary
  const totalOssScore = judged.reduce((s, r) => s + r.oss_score.total, 0);
  const totalCommercialScore = judged.reduce((s, r) => s + r.commercial_score.total, 0);
  const maxPossible = judged.length * 15;

  console.log("\n===== JUDGING SUMMARY =====");
  console.log(`OSS total quality:        ${totalOssScore}/${maxPossible}  (${((totalOssScore / maxPossible) * 100).toFixed(1)}%)`);
  console.log(`Commercial total quality: ${totalCommercialScore}/${maxPossible}  (${((totalCommercialScore / maxPossible) * 100).toFixed(1)}%)`);
  console.log(`\nNote: Judge is the same model family as commercial respondent (gpt-4o-mini).`);
  console.log(`Self-bias is expected and should be disclosed in the blog. Results are directional.`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
