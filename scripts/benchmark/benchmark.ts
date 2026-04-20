import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import OpenAI from "openai";

// ---------- Config ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_FILE = path.join(__dirname, "prompts.json");
const OUTPUT_FILE = path.join(__dirname, "results-raw.json");

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OSS_MODEL = process.env.OSS_MODEL || "llama3.2:1b";
const COMMERCIAL_MODEL = process.env.COMMERCIAL_MODEL || "gpt-4o-mini";

// OpenAI pricing (USD per 1M tokens) - update if OpenAI changes pricing
const OPENAI_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4o": { input: 2.50, output: 10.00 },
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Types ----------
type Prompt = {
  id: string;
  category: string;
  prompt: string;
};

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

// ---------- Utilities ----------
function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ---------- OSS runner (Ollama, streaming) ----------
async function runOllama(prompt: string, model: string): Promise<ModelRun> {
  const started = Date.now();
  let firstTokenAt: number | null = null;
  let output = "";
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.response) {
            if (firstTokenAt === null) firstTokenAt = Date.now();
            output += chunk.response;
          }
          if (chunk.done) {
            inputTokens = chunk.prompt_eval_count ?? 0;
            outputTokens = chunk.eval_count ?? 0;
          }
        } catch {
          // partial JSON, skip
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      model,
      response: "",
      input_tokens: 0,
      output_tokens: 0,
      first_token_ms: null,
      total_duration_ms: Date.now() - started,
      tokens_per_second: 0,
      cost_usd: 0,
      error: msg,
    };
  }

  const total = Date.now() - started;
  const firstToken = firstTokenAt ? firstTokenAt - started : null;
  const tps = outputTokens > 0 && total > 0 ? (outputTokens / total) * 1000 : 0;

  return {
    model,
    response: output.trim(),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    first_token_ms: firstToken,
    total_duration_ms: total,
    tokens_per_second: tps,
    cost_usd: 0, // local, no API cost
    error: null,
  };
}

// ---------- Commercial runner (OpenAI, streaming) ----------
async function runOpenAI(prompt: string, model: string): Promise<ModelRun> {
  const started = Date.now();
  let firstTokenAt: number | null = null;
  let output = "";
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const stream = await openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: true,
      stream_options: { include_usage: true },
    });

    for await (const chunk of stream) {
      const token = chunk.choices?.[0]?.delta?.content;
      if (token) {
        if (firstTokenAt === null) firstTokenAt = Date.now();
        output += token;
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? 0;
        outputTokens = chunk.usage.completion_tokens ?? 0;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      model,
      response: "",
      input_tokens: 0,
      output_tokens: 0,
      first_token_ms: null,
      total_duration_ms: Date.now() - started,
      tokens_per_second: 0,
      cost_usd: 0,
      error: msg,
    };
  }

  const total = Date.now() - started;
  const firstToken = firstTokenAt ? firstTokenAt - started : null;
  const tps = outputTokens > 0 && total > 0 ? (outputTokens / total) * 1000 : 0;

  const pricing = OPENAI_PRICING[model] || { input: 0, output: 0 };
  const cost =
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output;

  return {
    model,
    response: output.trim(),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    first_token_ms: firstToken,
    total_duration_ms: total,
    tokens_per_second: tps,
    cost_usd: cost,
    error: null,
  };
}

// ---------- Main ----------
async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("ERROR: OPENAI_API_KEY not set. Check .env file.");
    process.exit(1);
  }

  log("Loading prompts...");
  const raw = fs.readFileSync(PROMPTS_FILE, "utf-8");
  const data = JSON.parse(raw) as { prompts: Prompt[] };
  log(`Loaded ${data.prompts.length} prompts.`);

  const results: PromptResult[] = [];

  for (let i = 0; i < data.prompts.length; i++) {
    const p = data.prompts[i];
    log(`(${i + 1}/${data.prompts.length}) [${p.category}] ${p.id}: "${p.prompt.slice(0, 60)}..."`);

    log(`  -> OSS (${OSS_MODEL})...`);
    const oss = await runOllama(p.prompt, OSS_MODEL);
    if (oss.error) {
      log(`     ERROR: ${oss.error}`);
    } else {
      log(`     done. ${oss.output_tokens} tokens, ${(oss.total_duration_ms / 1000).toFixed(1)}s, ${oss.tokens_per_second.toFixed(1)} tok/s`);
    }

    log(`  -> Commercial (${COMMERCIAL_MODEL})...`);
    const commercial = await runOpenAI(p.prompt, COMMERCIAL_MODEL);
    if (commercial.error) {
      log(`     ERROR: ${commercial.error}`);
    } else {
      log(`     done. ${commercial.output_tokens} tokens, ${(commercial.total_duration_ms / 1000).toFixed(1)}s, ${commercial.tokens_per_second.toFixed(1)} tok/s, $${commercial.cost_usd.toFixed(6)}`);
    }

    results.push({
      id: p.id,
      category: p.category,
      prompt: p.prompt,
      oss,
      commercial,
    });

    // save incrementally so we never lose progress
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), "utf-8");
  }

  log(`All done. Wrote ${OUTPUT_FILE}`);

  // Quick summary
  const totalOssTime = results.reduce((s, r) => s + r.oss.total_duration_ms, 0);
  const totalCommercialTime = results.reduce((s, r) => s + r.commercial.total_duration_ms, 0);
  const totalCost = results.reduce((s, r) => s + r.commercial.cost_usd, 0);
  const totalOssTokens = results.reduce((s, r) => s + r.oss.output_tokens, 0);
  const totalCommercialTokens = results.reduce((s, r) => s + r.commercial.output_tokens, 0);

  console.log("\n===== SUMMARY =====");
  console.log(`OSS total time:        ${(totalOssTime / 1000).toFixed(1)}s`);
  console.log(`Commercial total time: ${(totalCommercialTime / 1000).toFixed(1)}s`);
  console.log(`OSS total tokens:        ${totalOssTokens}`);
  console.log(`Commercial total tokens: ${totalCommercialTokens}`);
  console.log(`Total commercial cost: $${totalCost.toFixed(4)}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
