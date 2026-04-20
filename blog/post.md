---
title: "How to Deploy an Open Source LLM Reliably"
subtitle: "Building a production-grade LLM stack on an 8GB laptop — probes, metrics, alerts, and the three bugs that taught me the most."
slug: how-to-deploy-open-source-llm-reliably
tags: kubernetes, llm, observability, sre, devops
---

An 8GB laptop. A 1.2-billion-parameter LLM. A single-node Kubernetes cluster hosting both the model and its own monitoring stack. The question wasn't *can this run?* The question was *can this run reliably?*

Reliability is a word I've seen used in two very different ways. In most LLM tutorials, it means "the pod is running." In production, it means "when an engineer asks the model something, they get a useful answer, and when they don't, something alerts before the user does." This post is about the second kind.

I set out to deploy an open-source LLM on Kubernetes the way I'd want it deployed in a company I was responsible for. Right-sized. Observable. With probes that actually mean something. With alerts that fire on real problems, not just liveness timeouts. And with the humility to know that even after all of that, things will still break — which is exactly why the observability matters.

Here's what I learned.

## 1. Right-sizing the model

The first instinct with LLMs is to pick the biggest model your API budget allows. On-prem, that instinct is wrong. The right question is: *what's the largest model that leaves enough headroom for the workload around it?*

I ran [llmfit](https://github.com/AlexsJones/llmfit) against my laptop. It inspected CPU, RAM, and available accelerators, then recommended model sizes:

| Model size | Fit rating |
|---|---|
| 7B (Q4) | Will not fit |
| 3B (Q4) | Marginal |
| **1B (Q4)** | **Recommended** |

With 8GB total RAM — of which Windows and Docker Desktop already consume 2-3GB, and my monitoring stack would need another 1.5GB — I had roughly 3-4GB left for the model, its runtime, and the ingress layer. A 1B model at Q4 or Q8 quantization is the honest choice. Llama 3.2 1B, specifically: recent, well-behaved, reasonable instruction-following.

This sounds like a compromise. It isn't. A 1B model that has the CPU and RAM it needs will outperform a 7B model that's been crammed into a pod and OOMKilled every other request. Reliability begins at model selection.

## 2. Deploying to Kubernetes

The deployment itself was the easy part. Ollama has an official image. A small Deployment, a PersistentVolumeClaim for model storage, a ClusterIP Service. Strategy: `Recreate`, because multiple Ollama pods sharing the same model volume is a disaster waiting to happen.

```yaml
spec:
  strategy:
    type: Recreate
  template:
    spec:
      containers:
        - name: ollama
          image: ollama/ollama:0.4.7
          resources:
            requests: { cpu: "500m", memory: "1Gi" }
            limits:   { cpu: "3000m", memory: "3Gi" }
          volumeMounts:
            - name: models
              mountPath: /root/.ollama
```

The interesting part was the readiness probe. This is where most LLM tutorials quietly give up.

The default Kubernetes probe for a web service is an HTTP GET on `/` or a TCP socket check. Both of those *lie* for an LLM. The Ollama HTTP server starts in a couple of seconds. The model takes much longer to load into memory and become ready for inference. During that gap, a TCP probe says "healthy," and the first real user request times out. I wanted a probe that actually checked *inference works*.

My first attempt was a `curl` against `/api/generate` with a one-token prompt. It failed immediately — the Ollama container image doesn't ship with `curl`. I switched to `wget`. It also isn't there. The only tool inside the container is `ollama` itself. So the probe became:

```yaml
readinessProbe:
  exec:
    command: ["sh", "-c", "ollama list | grep -q 'llama3.2:1b' && ollama run llama3.2:1b 'hi' >/dev/null 2>&1"]
```

That *worked*, and it was the most honest probe I could write. Ollama lists the model, and a real inference runs. If either fails, the pod isn't Ready. Simple.

Then reality showed up.

Under real CPU pressure — with Prometheus scraping, Grafana rendering, and the exporter doing synthetic probes of its own — my readiness probe started timing out intermittently. Not because inference was broken. Because the pod simply couldn't fit a full generation into the probe's timeout window while also serving real traffic. The Kubernetes control plane, doing what it was told, pulled the pod from the Service's endpoints. Users got 502s on a pod that was technically running fine.

The honest fix wasn't to make the probe stricter. It was to split the concern across two layers:

- **Kubernetes readiness probe**: lightweight — check that the model file is loaded (`ollama list | grep -q 'llama3.2:1b'`). Fast. Runs every 20 seconds.
- **Continuous inference validation**: a separate exporter sidecar runs a real single-token inference every 30 seconds and emits the latency as a metric. If inference *breaks*, I see it on the dashboard and in alerts, not through pod churn.

This felt like a step back at first. It's actually a step forward. The K8s probe answers "can this pod accept traffic right now?" The exporter answers "is the model actually producing tokens at acceptable latency?" Those are different questions, and conflating them — which my first probe did — is why the deployment fell over under load. Splitting them made both stronger.

More on the exporter in the next section.

## 3. Observability: beyond uptime

A kube-prometheus-stack install gives you a lot for free — Prometheus, Grafana, Alertmanager, node-exporter, kube-state-metrics, all wired up through the Prometheus Operator with sensible defaults. Within ten minutes of `helm install`, I had three working dashboards: cluster-wide health, namespace-level resource usage, and per-pod metrics.

![K8s cluster dashboard from kube-prometheus-stack](./media/dashboard-cluster.png)

That's the foundation. But none of it knows anything about *LLM inference*. The stack will happily tell me the Ollama pod's CPU utilization and memory working set. It won't tell me:

- Is the model loaded?
- How many tokens per second is the model producing right now?
- What's the p95 latency of a real inference call?
- Are any synthetic probes failing?

For those, I had to instrument Ollama myself.

Ollama doesn't expose a Prometheus metrics endpoint. I wrote a small Python exporter — about 120 lines using `prometheus_client` — that:

1. Polls the Ollama API every 30 seconds (`/api/tags`, `/api/ps`, and a single-token generation against the loaded model).
2. Records the result as Prometheus metrics.
3. Serves `/metrics` on port 9101.

I deployed it as a **sidecar container** in the same pod as Ollama. That's deliberate. A sidecar runs in the same network namespace, so it can hit `localhost:11434` without any service indirection. If Ollama is unreachable from inside its own pod, something genuinely broken is happening — not a networking artefact.

The metrics I exposed:

| Metric | Type | What it tells me |
|---|---|---|
| `ollama_up` | gauge | Exporter successfully reached Ollama this cycle |
| `ollama_loaded_models` | gauge | Number of models currently in memory |
| `ollama_request_duration_seconds` | histogram | Actual inference latency, bucketed |
| `ollama_tokens_per_second` | gauge | Rolling throughput |
| `ollama_tokens_total` | counter | Cumulative tokens produced |
| `ollama_probe_errors_total` | counter | Probe failures, labelled by error type |

The operator's ServiceMonitor picked up the exporter automatically (label selector `app: ollama, release: kps`). Targets showed up in the Prometheus UI within a minute, and a custom Grafana dashboard with eleven panels was live:

![Custom LLM observability dashboard](./media/dashboard-llm-custom.png)

The top row shows request rate, p50/p95/p99 latency, and tokens per second. The middle rows break down errors by type and cumulative token production. The bottom panels show the model inventory and whether Ollama is up.

This is the difference between *monitoring a pod* and *monitoring an LLM*. A TCP probe and a CPU graph tell you nothing about whether the model is actually serving useful tokens. A 30-second synthetic probe writing to a histogram tells you exactly that — and the histogram is what feeds the alerts.

## 4. Real alerts on real data

With the histogram in place, writing alerts was straightforward. I created a PrometheusRule with three rules:

```yaml
groups:
  - name: ollama.rules
    rules:
      - alert: OllamaDown
        expr: ollama_up == 0
        for: 1m
        labels: { severity: critical }
      - alert: OllamaHighInferenceLatency
        expr: histogram_quantile(0.95, rate(ollama_request_duration_seconds_bucket[5m])) > 10
        for: 2m
        labels: { severity: warning }
      - alert: OllamaProbeErrorsRising
        expr: rate(ollama_probe_errors_total[5m]) > 0.1
        for: 3m
        labels: { severity: warning }
```

The interesting one is `OllamaHighInferenceLatency`. It fires when the p95 of synthetic probe durations exceeds 10 seconds over a 2-minute window.

Here's what made this feel real: **it fired on its own during development**, before I'd written a single word about it. I was running the cluster, building the UI, and the alert popped up in the Prometheus UI because inference latency really was degraded — CPU contention from Grafana rendering and Chrome eating cycles was pushing probe durations into the tens of seconds.

![OllamaHighInferenceLatency firing on real data](./media/prometheus-alert-firing.png)

I didn't stage this. I didn't write a load test to trigger it. I built honest instrumentation, and the instrumentation caught a real degradation pattern I would have missed otherwise. That's the whole point of observability work — the alerts you write should protect future-you from present-you's blind spots. This one did its job on day one.

The lesson I took from it: don't build alerts around artificial failures. Build them around metrics that move for real reasons, and let real usage tell you if the thresholds are right.

## 5. OSS vs commercial: the honest trade-off

Reliability is table stakes. The second half of the "is this worth deploying on-prem?" question is *how good is the model, really*. To answer that, I ran a small, structured comparison.

Ten prompts across four categories — factual recall, reasoning, code generation, summarization — sent to both the local Llama 3.2 1B (running in the Kubernetes pod I'd just built) and OpenAI's GPT-4o-mini. For each response I recorded latency, tokens generated, tokens per second, and API cost. A separate judging pass then scored each response on accuracy, completeness, and clarity.

The benchmark runs are offline: a Node script hits both models, writes `results.json`, and a `/compare` route in the chatbot UI reads that JSON and displays it. Keeping generation and display separate meant I could re-run the benchmark without touching the UI, and the UI never depends on network availability at render time.

The summary:

| | Llama 3.2 1B (local) | GPT-4o-mini (API) |
|---|---|---|
| Total wall-clock time | 845 s | 57 s |
| Total tokens produced | 2,394 | 2,389 |
| Average tokens / second | 2.8 | 42 |
| Quality score | 121 / 150 (**80.7%**) | 148 / 150 (**98.7%**) |
| API cost for the batch | $0 | $0.0015 |

![Benchmark summary: OSS vs GPT-4o-mini](./media/compare-summary.png)

The headline is easy to read wrong. *Commercial is faster and slightly better, therefore obviously use commercial.* That's not the whole story.

Breaking it down by category:

- **Simple factual recall**: tied, 15/15 each. A 1B model handles "what is Kubernetes" as well as a frontier model.
- **Summarization**: essentially tied. When the task is bounded ("summarize in two sentences"), small models are fine.
- **Factual with specifics**: OSS drops to 9/15 on a prompt asking for three Prometheus functions with descriptions — it named them but got details wrong.
- **Multi-step reasoning**: OSS drops to 10/15 on prompts like "a pod keeps OOMKilling, list the top five causes." The answers aren't wrong, they're shallow.
- **Code generation**: OSS produces working code but misses small conventions a commercial model nails.

So the real summary: a 1B model on a laptop gets you **80% of the quality at 15× the latency and zero marginal API cost**. For factual lookups, summaries, and low-stakes chat, it's genuinely competitive. For multi-step reasoning or specifics-heavy factual work, it isn't there yet.

### A note on methodology and bias

The judging was done by GPT-4o-mini — the same model that produced one of the two response sets. That's a deliberate trade-off: running a third judge model costs more and introduces its own biases, and GPT-4o-mini as judge is at least a known quantity. But the bias is real and worth being explicit about.

I did two things to mitigate it:

1. **Randomized position.** Each judging call receives the two responses in a random order (A/B), and the script unshuffles the scores. LLMs tend to prefer the response that appears first; randomization breaks that.
2. **Disclosed it.** The `/compare` page shows a methodology note. The commercial score is probably inflated by somewhere between 5 and 10 points. A fairer read is "commercial ≈ 88-93%, OSS ≈ 80%." The gap is real, but smaller than the raw scores suggest.

![Methodology disclosure shown in the comparison UI](./media/compare-methodology.png)

Treat the results as directional, not absolute. They're good enough to answer *should I deploy the 1B locally or pay the API?* — and honest enough that I trust them for that decision.

## 6. The 3 bugs that taught me the most

Over the course of building this, three bugs hit hard enough to be worth writing down. None of them were exotic. All of them are the sort of thing you'd hit on the second Tuesday of any production LLM project. Collectively they taught me more about Kubernetes networking and pod lifecycle than the rest of the project combined.

### Bug 1 — The probe that wasn't

**Symptom:** Pod stuck at `0/1 Ready` forever. Logs clean. No crashloop. Just indefinite unreadiness.

**Diagnostic:** `kubectl describe pod` showed the readiness probe was exiting non-zero, but the probe command itself (`curl -s http://localhost:11434/api/tags`) didn't look wrong. `kubectl exec` into the container:

```bash
$ kubectl exec -n llm deployment/ollama -- curl --version
/bin/sh: curl: not found
```

The Ollama container image doesn't ship with `curl`. My probe command was failing not because Ollama was unhealthy, but because the tool I was using to check it didn't exist. I swapped to `wget`. Same story. Finally checked what the image *does* have:

```bash
$ kubectl exec -n llm deployment/ollama -- which ollama
/bin/ollama
```

**Fix:** Probe using the only tool available:

```yaml
readinessProbe:
  exec:
    command: ["sh", "-c", "ollama list | grep -q 'llama3.2:1b'"]
```

**Lesson:** Probes run *inside* the container, with that container's binaries. If you're probing a third-party image, verify what shell tools actually exist before assuming `curl` is there. This cost me an hour. It's the kind of thing a linter can't catch for you.

### Bug 2 — Stale DNS, silent 502

**Symptom:** The chat UI suddenly returned `502 Bad Gateway` after I'd updated the Ollama Service to expose an additional port. UI pod logs showed upstream connection refused.

**Diagnostic:** I checked the Service endpoints — populated correctly. I checked the Ollama pod — running, accepting connections. I even `kubectl exec`-ed into the UI pod and `wget`-ed the Ollama Service DNS name. It worked fine.

But the nginx error log told the real story:

```
connect() failed (111: Connection refused) while connecting to upstream,
upstream: "http://10.96.70.171:11434/api/chat"
```

That IP was the Service's *old* ClusterIP. When I'd updated the Service to add the metrics port, Kubernetes assigned a new ClusterIP. My UI's nginx, which `proxy_pass`-ed to the Service's DNS name, had resolved it *once* at startup and cached the IP. The cache was now stale.

**Fix:** Force nginx to re-resolve DNS per-request by using a variable in `proxy_pass`:

```nginx
resolver kube-dns.kube-system.svc.cluster.local valid=10s;
location /api/ {
  set $upstream "http://ollama.llm.svc.cluster.local:11434";
  proxy_pass $upstream$request_uri;
}
```

**Lesson:** A static hostname in `proxy_pass` is resolved once. Services can be recreated with new ClusterIPs. If the reverse proxy is inside the cluster, use a variable so nginx re-resolves on every request. This bug is *invisible* until a Service churns — which is exactly when you can't afford silent failure.

### Bug 3 — Empty endpoints under CPU pressure

**Symptom:** Chat UI returning `502` intermittently. The Ollama pod showed `Running`. But:

```
$ kubectl get endpoints -n llm ollama
NAME     ENDPOINTS   AGE
ollama               12h
```

Empty. A Service with no endpoints. Yet the backing pod was `Running`.

**Diagnostic:** The pod showed `1/2` in the READY column — the Ollama container was Ready, but the exporter sidecar was not. Kubernetes excludes pods from Service endpoints if *any* container in the pod isn't Ready. The exporter's readiness probe was a 1-second HTTP timeout against `/healthz`, and under CPU pressure (Prometheus scraping + Grafana rendering + my browser) the exporter's event loop was occasionally slow enough that the probe timed out.

Meanwhile the Ollama readiness probe — which actually ran a full inference on every check — was *also* timing out occasionally, for the same reason.

So the failure mode was: under load, probes time out → one or both containers flip to NotReady → pod drops from endpoints → Service has no backend → UI gets 502 → by the time I run `kubectl describe`, the pod is Ready again and the 502 is "gone."

**Fix:** Two things:

1. **Soften the Ollama probe** to not trigger inference every time. Real inference validation moved to the exporter's 30-second synthetic probe (see Section 3).
2. **Make the exporter's probe forgiving**: timeout 1s → 5s, period 10s → 30s. It's a sidecar; it doesn't need sub-second probing.

**Lesson:** Readiness probes are not free. Every probe consumes resources. If your probes are themselves causing the failures they're supposed to detect, you're in a feedback loop. The fix is to make probes *honest, not aggressive* — and to separate "is this pod alive?" (cheap) from "is inference working end-to-end?" (expensive, continuous, via metrics).

---

None of these three bugs are written up in the Kubernetes docs as "gotchas for LLM deployments." They're just Kubernetes gotchas. What I took away is that deploying an LLM is mostly a Kubernetes project with a large container inside it — and the reliability work is the Kubernetes work.

## 7. What I'd do differently in production

This stack runs on an 8GB laptop. Every choice I made was shaped by that constraint. If I were deploying this for a team to actually use, a few things would change:

- **Separate monitoring from the workload.** Prometheus, Grafana, and Alertmanager should run in their own node pool. Putting them on the same node as the LLM meant that every time Grafana rendered a dashboard, the exporter's synthetic probe got starved. In a production cluster you pay for the separation; on a laptop you learn why it exists.
- **GPU runtime.** Running a 1B model at 2-5 tokens per second on CPU is fine for a demo, painful in practice. A single T4 or a Mac M-series would push throughput an order of magnitude higher and eliminate most of the CPU-contention failure modes.
- **Real rate limiting.** The chatbot UI has no rate limiting. A single user hitting it in a loop could wedge the model. In production, rate-limit at ingress (nginx-ingress has an annotation for this) or run a small queue in front of the model.
- **Probe observability.** I would emit metrics on probe *success rate* and *probe duration* specifically, so the alerting catches "probes are starting to time out" *before* it manifests as empty Service endpoints. Observing the observers.
- **Model warm-up endpoint.** Right now, the first real user request after a restart is slow while the model loads. A small init-container or a warm-up job would load the model into memory before the pod reports Ready, smoothing out cold-start latency.

None of these are novel. All of them are the kind of work that happens after the initial "it works on my machine" milestone. That gap — between "deployed" and "reliable" — is where most of the interesting engineering happens.

## 8. Closing

I started this project to see how far I could push reliability on a constrained setup. The answer turned out to be surprisingly far. A right-sized model, honest probes split across two layers, custom LLM metrics and alerts that fire on real degradation, and a small benchmark that tells me when commercial is worth paying for. All of it running on the same laptop I'm writing this on.

Reliability isn't a library you install. It's a stack of deliberate choices — model selection, probe design, metric instrumentation, alert thresholds, incident learnings — each of which compounds. The three bugs that tripped me up weren't signs the stack was weak; they were the stack teaching me what to instrument next.

If you're deploying an open-source LLM, I'd offer one piece of advice above all the rest: **build your observability before you need it**. The alert that catches a problem you didn't know you had is worth a hundred dashboards full of metrics nobody looks at.

---

**Repo:** https://github.com/chinmoypaul8897/drdroid-llm-reliability
**Published:** https://chinmoypaul.hashnode.dev/how-to-deploy-an-open-source-llm-reliably
**Stack:** Kubernetes (kind) · Ollama · Llama 3.2 1B · Prometheus · Grafana · React · nginx-ingress
**Inspired by:** [DrDroid's LGTM stack blog](https://drdroid.io/) — their approach to reliability-focused tooling content shaped how I thought about this project.