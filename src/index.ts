import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { describeRoute, openAPIRouteHandler } from "hono-openapi";

const app = new Hono<{ Bindings: Env }>();

// === Provider Interface ===

interface GPUCreateRequest {
  gpu: string;
  image: string;
  disk_gb: number;
}

interface GPUCreateResult {
  pod_id: string;
  gpu: string;
  image: string;
  status: string;
  ports: Array<{ ip?: string; privatePort?: number; publicPort?: number; type?: string }>;
}

interface GPUStatusResult {
  pod_id: string;
  status: string;
  name: string;
  uptime_seconds: number;
  ports: Array<{ ip?: string; privatePort?: number; publicPort?: number; type?: string }>;
  ssh_command: string | null;
}

interface GPUProvider {
  create(env: Env, req: GPUCreateRequest): Promise<GPUCreateResult>;
  status(env: Env, podId: string): Promise<GPUStatusResult>;
  destroy(env: Env, podId: string): Promise<void>;
  gpus: Record<string, string>;
  defaultImage: string;
}

// === RunPod Provider ===

const RUNPOD_GRAPHQL = "https://api.runpod.io/graphql";

async function runpodQuery(apiKey: string, query: string): Promise<any> {
  const res = await fetch(RUNPOD_GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(`RunPod API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

const runpodProvider: GPUProvider = {
  gpus: {
    RTX_A4000: "NVIDIA RTX A4000",
    RTX_3090: "NVIDIA GeForce RTX 3090",
    RTX_4090: "NVIDIA GeForce RTX 4090",
    A100_80GB: "NVIDIA A100 80GB PCIe",
  },
  defaultImage: "runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04",

  async create(env, req) {
    const gpuTypeId = this.gpus[req.gpu];
    const podName = `x402-gpu-${Date.now()}`;

    // Escape strings to prevent GraphQL injection
    const safeName = podName.replace(/"/g, '\\"');
    const safeImage = req.image.replace(/"/g, '\\"');
    const safeGpuType = gpuTypeId.replace(/"/g, '\\"');

    const mutation = `
      mutation {
        podFindAndDeployOnDemand(input: {
          name: "${safeName}",
          imageName: "${safeImage}",
          gpuTypeId: "${safeGpuType}",
          cloudType: COMMUNITY,
          volumeInGb: 0,
          containerDiskInGb: ${req.disk_gb},
          minVcpuCount: 2,
          minMemoryInGb: 8
        }) {
          id
          imageName
          machineId
          machine { podHostId }
          runtime {
            uptimeInSeconds
            ports { ip isIpPublic privatePort publicPort type }
          }
        }
      }
    `;

    const data = await runpodQuery(env.RUNPOD_API_KEY, mutation);
    if (data.errors) throw new Error(JSON.stringify(data.errors));

    const pod = data.data.podFindAndDeployOnDemand;
    return {
      pod_id: pod.id,
      gpu: req.gpu,
      image: pod.imageName,
      status: "starting",
      ports: pod.runtime?.ports || [],
    };
  },

  async status(env, podId) {
    const safePodId = podId.replace(/"/g, '\\"');
    const query = `
      query {
        pod(input: { podId: "${safePodId}" }) {
          id
          name
          runtime {
            uptimeInSeconds
            gpus { id }
            ports { ip isIpPublic privatePort publicPort type }
          }
        }
      }
    `;

    const data = await runpodQuery(env.RUNPOD_API_KEY, query);
    if (data.errors) throw new Error(JSON.stringify(data.errors));

    const pod = data.data.pod;
    if (!pod) throw new Error("Pod not found");

    const runtime = pod.runtime;
    const ports = runtime?.ports || [];
    const sshPort = ports.find((p: any) => p.privatePort === 22 && p.isIpPublic);

    let status: string;
    if (runtime && runtime.uptimeInSeconds > 0) status = "running";
    else if (runtime) status = "starting";
    else status = "stopped";

    return {
      pod_id: pod.id,
      status,
      name: pod.name,
      uptime_seconds: runtime?.uptimeInSeconds || 0,
      ports,
      ssh_command: sshPort ? `ssh root@${sshPort.ip} -p ${sshPort.publicPort}` : null,
    };
  },

  async destroy(env, podId) {
    const safePodId = podId.replace(/"/g, '\\"');
    const mutation = `mutation { podTerminate(input: { podId: "${safePodId}" }) }`;
    const data = await runpodQuery(env.RUNPOD_API_KEY, mutation);
    if (data.errors) throw new Error(JSON.stringify(data.errors));
  },
};

// === Provider Registry ===
// Add new providers here (e.g. lambdaProvider, vastaiProvider)

const providers: Record<string, GPUProvider> = {
  runpod: runpodProvider,
};

function getProvider(env: Env): GPUProvider {
  const name = env.PROVIDER || "runpod";
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown provider: ${name}. Available: ${Object.keys(providers).join(", ")}`);
  return provider;
}

// === OpenAPI spec — must be before paymentMiddleware ===

app.get("/.well-known/openapi.json", openAPIRouteHandler(app, {
  documentation: {
    info: {
      title: "x402 GPU Service",
      description: "On-demand GPU instances via RunPod. Pay via x402, get a GPU pod. Pay-per-use via x402 protocol on Base mainnet.",
      version: "1.0.0",
    },
    servers: [{ url: "https://gpu.camelai.io" }],
  },
}));

// === x402 payment gates ===

app.use(
  cdpPaymentMiddleware(
    (env) => ({
      "POST /create": {
        accepts: [
          {
            scheme: "exact",
            price: "$1.00",
            network: "eip155:8453",
            payTo: env.SERVER_ADDRESS as `0x${string}`,
          },
        ],
        description: "Provision an on-demand GPU instance. Pay, get a GPU, use it.",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            inputSchema: {
              bodyFields: {
                gpu: {
                  type: "string",
                  description:
                    "GPU type: RTX_A4000, RTX_3090, RTX_4090, or A100_80GB (default: RTX_A4000)",
                  required: false,
                },
                image: {
                  type: "string",
                  description: "Docker image (default: pytorch with CUDA)",
                  required: false,
                },
                disk_gb: {
                  type: "number",
                  description: "Container disk size in GB (default: 20)",
                  required: false,
                },
              },
            },
          },
        },
      },
      "GET /status/:pod_id": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.001",
            network: "eip155:8453",
            payTo: env.SERVER_ADDRESS as `0x${string}`,
          },
        ],
        description: "Check the status of a GPU pod",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            inputSchema: {
              pathFields: {
                pod_id: {
                  type: "string",
                  description: "The pod ID returned from /create",
                  required: true,
                },
              },
            },
          },
        },
      },
    })
  )
);

// === POST /create ===

app.post("/create", describeRoute({
  description: "Provision an on-demand GPU instance. Requires x402 payment ($1.00).",
  requestBody: {
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            gpu: { type: "string", description: "GPU type: RTX_A4000, RTX_3090, RTX_4090, or A100_80GB" },
            image: { type: "string", description: "Docker image (default: pytorch with CUDA)" },
            disk_gb: { type: "number", description: "Container disk size in GB (default: 20)" },
          },
        },
      },
    },
  },
  responses: {
    200: { description: "GPU pod created", content: { "application/json": { schema: { type: "object" } } } },
    400: { description: "Invalid GPU type" },
    402: { description: "Payment required" },
    502: { description: "Failed to create GPU pod" },
  },
}), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const provider = getProvider(c.env);

  const gpuKey = (body.gpu as string) || "RTX_A4000";
  if (!provider.gpus[gpuKey]) {
    return c.json(
      { error: `Invalid GPU type '${gpuKey}'. Must be one of: ${Object.keys(provider.gpus).join(", ")}` },
      400
    );
  }

  const image = (body.image as string) || provider.defaultImage;
  const diskGb = Math.min(Math.max(Number(body.disk_gb) || 20, 5), 100);

  try {
    const result = await provider.create(c.env, { gpu: gpuKey, image, disk_gb: diskGb });
    return c.json({ ...result, provider: c.env.PROVIDER || "runpod" });
  } catch (err: any) {
    return c.json({ error: "Failed to create GPU pod", details: err.message }, 502);
  }
});

// === GET /status/:pod_id ===

app.get("/status/:pod_id", describeRoute({
  description: "Check the status of a GPU pod. Requires x402 payment ($0.001).",
  responses: {
    200: { description: "Pod status", content: { "application/json": { schema: { type: "object" } } } },
    402: { description: "Payment required" },
    404: { description: "Pod not found" },
    502: { description: "Provider API error" },
  },
}), async (c) => {
  const provider = getProvider(c.env);
  try {
    const result = await provider.status(c.env, c.req.param("pod_id"));
    return c.json(result);
  } catch (err: any) {
    const status = err.message.includes("not found") ? 404 : 502;
    return c.json({ error: err.message }, status);
  }
});

// === DELETE /destroy/:pod_id (free) ===

app.delete("/destroy/:pod_id", describeRoute({
  description: "Terminate a GPU pod (free).",
  responses: {
    200: { description: "Pod destroyed", content: { "application/json": { schema: { type: "object" } } } },
    502: { description: "Failed to destroy pod" },
  },
}), async (c) => {
  const provider = getProvider(c.env);
  try {
    await provider.destroy(c.env, c.req.param("pod_id"));
    return c.json({ destroyed: true, pod_id: c.req.param("pod_id") });
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

// === Health ===

app.get("/", describeRoute({
  description: "Health check and service info.",
  responses: {
    200: { description: "Service info", content: { "application/json": { schema: { type: "object" } } } },
  },
}), (c) => {
  const provider = getProvider(c.env);
  return c.json({
    service: "x402-gpu",
    description: "On-demand GPU instances. Pay via x402, get a GPU pod.",
    provider: c.env.PROVIDER || "runpod",
    available_providers: Object.keys(providers),
    gpu_options: Object.keys(provider.gpus),
    endpoints: {
      "POST /create": "$1.00",
      "GET /status/:pod_id": "$0.001",
      "DELETE /destroy/:pod_id": "free",
    },
  });
});

export default app;
