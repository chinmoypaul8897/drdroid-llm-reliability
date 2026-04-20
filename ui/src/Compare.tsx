import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  Server,
  Cloud,
  Zap,
  DollarSign,
  Gauge,
  Award,
  AlertCircle,
  MessageSquare,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
} from "recharts";
import resultsData from "./results.json";

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

type QualityScore = {
  accuracy: number;
  completeness: number;
  clarity: number;
  total: number;
  reasoning: string;
};

type Result = {
  id: string;
  category: string;
  prompt: string;
  oss: ModelRun;
  commercial: ModelRun;
  oss_score: QualityScore;
  commercial_score: QualityScore;
  judge_bias_disclosed: boolean;
};

const results = resultsData as Result[];

function sum<T>(arr: T[], fn: (x: T) => number): number {
  return arr.reduce((s, x) => s + fn(x), 0);
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

export default function Compare() {
  const [selectedId, setSelectedId] = useState<string>(results[0]?.id ?? "");
  const selected = results.find((r) => r.id === selectedId) ?? results[0];

  // Aggregates
  const totalOssTime = sum(results, (r) => r.oss.total_duration_ms);
  const totalCommercialTime = sum(results, (r) => r.commercial.total_duration_ms);
  const totalOssTokens = sum(results, (r) => r.oss.output_tokens);
  const totalCommercialTokens = sum(results, (r) => r.commercial.output_tokens);
  const totalOssCost = sum(results, (r) => r.oss.cost_usd);
  const totalCommercialCost = sum(results, (r) => r.commercial.cost_usd);
  const avgOssTps =
    sum(results, (r) => r.oss.tokens_per_second) / results.length;
  const avgCommercialTps =
    sum(results, (r) => r.commercial.tokens_per_second) / results.length;
  const totalOssQuality = sum(results, (r) => r.oss_score.total);
  const totalCommercialQuality = sum(results, (r) => r.commercial_score.total);
  const maxQuality = results.length * 15;

  // Chart data
  const speedData = results.map((r) => ({
    id: r.id,
    oss: Number(r.oss.tokens_per_second.toFixed(2)),
    commercial: Number(r.commercial.tokens_per_second.toFixed(2)),
  }));

  const qualityData = results.map((r) => ({
    id: r.id,
    oss: r.oss_score.total,
    commercial: r.commercial_score.total,
  }));

  return (
    <div className="min-h-full bg-neutral-950 text-neutral-200">
      {/* Header */}
      <header className="border-b border-neutral-800 bg-neutral-900/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-400">
              <Activity size={18} />
            </div>
            <div>
              <div className="text-sm font-semibold text-neutral-100">
                Benchmark: OSS vs Commercial
              </div>
              <div className="text-xs text-neutral-500">
                Llama 3.2 1B (local, K8s) vs GPT-4o-mini — {results.length} prompts
              </div>
            </div>
          </div>
          <Link
            to="/"
            className="flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-700"
          >
            <MessageSquare size={14} />
            Back to chat
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-8">
        {/* Summary cards */}
        <section className="mb-10">
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-neutral-500">
            Summary
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <SummaryCard
              title="Llama 3.2 1B"
              subtitle="Open-source, running on Kubernetes (CPU)"
              icon={<Server size={18} />}
              accentColor="text-emerald-400"
              bgColor="bg-emerald-500/5"
              borderColor="border-emerald-500/20"
              stats={[
                { label: "Total time", value: fmtMs(totalOssTime) },
                { label: "Avg tokens/sec", value: avgOssTps.toFixed(1) },
                { label: "Tokens generated", value: totalOssTokens.toString() },
                { label: "Quality", value: `${totalOssQuality}/${maxQuality}` },
                { label: "API cost", value: fmtCost(totalOssCost) },
              ]}
            />
            <SummaryCard
              title="GPT-4o-mini"
              subtitle="Commercial, OpenAI API"
              icon={<Cloud size={18} />}
              accentColor="text-blue-400"
              bgColor="bg-blue-500/5"
              borderColor="border-blue-500/20"
              stats={[
                { label: "Total time", value: fmtMs(totalCommercialTime) },
                { label: "Avg tokens/sec", value: avgCommercialTps.toFixed(1) },
                { label: "Tokens generated", value: totalCommercialTokens.toString() },
                { label: "Quality", value: `${totalCommercialQuality}/${maxQuality}` },
                { label: "API cost", value: fmtCost(totalCommercialCost) },
              ]}
            />
          </div>
        </section>

        {/* Charts */}
        <section className="mb-10 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ChartCard title="Speed (tokens / second)" icon={<Zap size={14} />}>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={speedData} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#27272a" vertical={false} />
                <XAxis dataKey="id" tick={{ fontSize: 10, fill: "#737373" }} />
                <YAxis tick={{ fontSize: 10, fill: "#737373" }} />
                <Tooltip
                  contentStyle={{
                    background: "#0a0a0a",
                    border: "1px solid #27272a",
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="oss" name="Llama 3.2 1B" fill="#10b981" />
                <Bar dataKey="commercial" name="GPT-4o-mini" fill="#3b82f6" />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="Quality score (out of 15)" icon={<Award size={14} />}>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={qualityData} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#27272a" vertical={false} />
                <XAxis dataKey="id" tick={{ fontSize: 10, fill: "#737373" }} />
                <YAxis domain={[0, 15]} tick={{ fontSize: 10, fill: "#737373" }} />
                <Tooltip
                  contentStyle={{
                    background: "#0a0a0a",
                    border: "1px solid #27272a",
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="oss" name="Llama 3.2 1B" fill="#10b981" />
                <Bar dataKey="commercial" name="GPT-4o-mini" fill="#3b82f6" />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </section>

        {/* Side-by-side viewer */}
        <section className="mb-10">
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-neutral-500">
            Side-by-side responses
          </h2>

          {/* Prompt selector */}
          <div className="mb-4 flex flex-wrap gap-2">
            {results.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                  selectedId === r.id
                    ? "border-neutral-600 bg-neutral-800 text-neutral-100"
                    : "border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-700"
                }`}
              >
                <span className="mr-1.5 text-neutral-600">[{r.category}]</span>
                {r.id}
              </button>
            ))}
          </div>

          {/* Prompt text */}
          <div className="mb-4 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
              Prompt
            </div>
            <div className="whitespace-pre-wrap text-sm text-neutral-200">{selected.prompt}</div>
          </div>

          {/* Two-column responses */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ResponseCard
              title="Llama 3.2 1B"
              subtitle="running on Kubernetes"
              icon={<Server size={14} />}
              accentColor="text-emerald-400"
              borderColor="border-emerald-500/20"
              run={selected.oss}
              score={selected.oss_score}
            />
            <ResponseCard
              title="GPT-4o-mini"
              subtitle="OpenAI API"
              icon={<Cloud size={14} />}
              accentColor="text-blue-400"
              borderColor="border-blue-500/20"
              run={selected.commercial}
              score={selected.commercial_score}
            />
          </div>
        </section>

        {/* Methodology disclosure */}
        <section className="mb-6 rounded-lg border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-neutral-300">
          <div className="mb-1 flex items-center gap-2 text-amber-400">
            <AlertCircle size={14} />
            <span className="text-xs font-semibold uppercase tracking-wider">Methodology</span>
          </div>
          <p className="text-xs leading-relaxed text-neutral-400">
            Judging was performed by GPT-4o-mini, the same model used for the commercial response.
            Self-bias is expected and likely inflates the commercial score by 5-10%. Results are
            directional, not absolute. Response position (A/B) was randomized per prompt to mitigate
            ordering bias. OSS model runs on an 8GB laptop under Kubernetes, CPU-only.
          </p>
        </section>
      </div>
    </div>
  );
}

// ---------- Helpers ----------

type StatItem = { label: string; value: string };

function SummaryCard({
  title,
  subtitle,
  icon,
  accentColor,
  bgColor,
  borderColor,
  stats,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  accentColor: string;
  bgColor: string;
  borderColor: string;
  stats: StatItem[];
}) {
  return (
    <div className={`rounded-lg border ${borderColor} ${bgColor} p-5`}>
      <div className="mb-4 flex items-center gap-2">
        <div className={`${accentColor}`}>{icon}</div>
        <div>
          <div className="text-sm font-semibold text-neutral-100">{title}</div>
          <div className="text-xs text-neutral-500">{subtitle}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {stats.map((s) => (
          <div key={s.label}>
            <div className="text-xs uppercase tracking-wider text-neutral-500">{s.label}</div>
            <div className="mt-0.5 font-mono text-sm text-neutral-100">{s.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChartCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="mb-3 flex items-center gap-2 text-neutral-300">
        <div className="text-neutral-500">{icon}</div>
        <div className="text-xs font-semibold uppercase tracking-wider">{title}</div>
      </div>
      {children}
    </div>
  );
}

function ResponseCard({
  title,
  subtitle,
  icon,
  accentColor,
  borderColor,
  run,
  score,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  accentColor: string;
  borderColor: string;
  run: ModelRun;
  score: QualityScore;
}) {
  return (
    <div className={`flex flex-col rounded-lg border ${borderColor} bg-neutral-900/40 p-4`}>
      <div className="mb-3 flex items-start justify-between">
        <div className="flex items-center gap-2">
          <div className={`${accentColor}`}>{icon}</div>
          <div>
            <div className="text-sm font-semibold text-neutral-100">{title}</div>
            <div className="text-xs text-neutral-500">{subtitle}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wider text-neutral-500">Quality</div>
          <div className="font-mono text-sm text-neutral-100">{score.total}/15</div>
        </div>
      </div>

      {/* Metrics row */}
      <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
        <Metric icon={<Gauge size={11} />} label="Time" value={fmtMs(run.total_duration_ms)} />
        <Metric icon={<Zap size={11} />} label="Tok/s" value={run.tokens_per_second.toFixed(1)} />
        <Metric icon={<DollarSign size={11} />} label="Cost" value={fmtCost(run.cost_usd)} />
      </div>

      {/* Response */}
      <div className="mb-3 flex-1 overflow-auto rounded-md border border-neutral-800 bg-neutral-950 p-3 text-xs leading-relaxed text-neutral-300 max-h-96">
        <pre className="whitespace-pre-wrap font-sans">{run.response || "(no response)"}</pre>
      </div>

      {/* Score breakdown */}
      <div className="border-t border-neutral-800 pt-3">
        <div className="mb-1.5 flex justify-between text-xs text-neutral-500">
          <span>Accuracy {score.accuracy}/5</span>
          <span>Completeness {score.completeness}/5</span>
          <span>Clarity {score.clarity}/5</span>
        </div>
        <div className="text-xs italic text-neutral-400">Judge: {score.reasoning}</div>
      </div>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5">
      <div className="text-neutral-500">{icon}</div>
      <div>
        <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
        <div className="font-mono text-xs text-neutral-200">{value}</div>
      </div>
    </div>
  );
}
