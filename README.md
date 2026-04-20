# drdroid-llm-reliability

Deploying an open-source LLM on Kubernetes with reliability as the first-class concern. Full stack: right-sized model, honest probes, custom Prometheus exporter, real alerts, chat UI, and a 10-prompt OSS vs commercial benchmark — all running on an 8GB laptop.

**Blog post:** [How to Deploy an Open Source LLM Reliably](https://chinmoypaul.hashnode.dev/how-to-deploy-open-source-llm-reliably)

---

## What's in this repo

- `k8s/` — Kubernetes manifests (kind cluster config, Ollama deployment, chat UI, ingress, PrometheusRule, Grafana dashboard JSON, Helm values for kube-prometheus-stack)
- `scripts/ollama-exporter/` — Custom Python Prometheus exporter, runs as a sidecar
- `scripts/benchmark/` — Offline OSS vs commercial benchmark (prompts, runner, LLM-as-judge scorer, results)
- `ui/` — Vite + React + TypeScript chat UI with `/chat` and `/compare` routes
- `blog/` — Blog post draft and supporting artefacts (llmfit output, baseline responses)
- `media/` — Screenshots and short recordings referenced in the blog

## Stack

- **Orchestration:** kind (Kubernetes 1.30.4, single-node)
- **Model runtime:** Ollama 0.4.7 + Llama 3.2 1B
- **Observability:** kube-prometheus-stack v83.6.0 (Prometheus + Grafana + Alertmanager)
- **Custom exporter:** Python 3.12, `prometheus_client`
- **UI:** Vite + React 19 + TypeScript + Tailwind + Recharts
- **Ingress:** ingress-nginx v1.12.1
- **Benchmark commercial model:** OpenAI GPT-4o-mini

## Key design decisions

- **1B model, not 7B.** Right-sized for 8GB RAM using [llmfit](https://github.com/AlexsJones/llmfit).
- **Two-layer readiness:** lightweight K8s probe + 30s synthetic inference probe via sidecar.
- **Custom `/metrics` endpoint** on port 9101 — Ollama doesn't expose one natively.
- **Benchmark is offline**, UI is display-only. Generation in Node, rendering in React.
- **Self-bias in judging disclosed**, not hidden. Results are directional.

See the blog post above for the full narrative — including the three real bugs that shaped the design.

## Reproducing locally

Requirements: Docker Desktop, kubectl, kind, Helm, Node 18+.

```bash
# 1. Cluster
kind create cluster --config k8s/kind-cluster.yaml

# 2. Ollama
kubectl apply -f k8s/ollama.yaml
kubectl exec -n llm deployment/ollama -- ollama pull llama3.2:1b

# 3. Monitoring
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install kps prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace -f k8s/prometheus-values.yaml

# 4. Exporter
docker build -t ollama-exporter:0.1.0 scripts/ollama-exporter/
kind load docker-image ollama-exporter:0.1.0 --name drdroid-llm

# 5. Alerts
kubectl apply -f k8s/ollama-alerts.yaml

# 6. UI
cd ui && npm install && npm run build
docker build -t drdroid-chat-ui:0.1.2 .
kind load docker-image drdroid-chat-ui:0.1.2 --name drdroid-llm
cd ..
kubectl apply -f k8s/chat-ui.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.1/deploy/static/provider/kind/deploy.yaml
kubectl label node drdroid-llm-control-plane ingress-ready=true
kubectl apply -f k8s/chat-ui-ingress.yaml

# 7. Access
kubectl port-forward -n ingress-nginx svc/ingress-nginx-controller 8080:80
# Open http://localhost:8080
```

Benchmark requires an OpenAI API key:

```bash
cd scripts/benchmark
# Create .env with: OPENAI_API_KEY=sk-...
npm install
npx tsx benchmark.ts
npx tsx judge.ts
```

## License

MIT — see `LICENSE`.

## Credits

Inspired by [DrDroid's](https://drdroid.io) reliability-focused engineering content. Built as a submission for their DevRel Intern role.