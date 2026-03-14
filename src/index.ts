import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { extractParams } from "x402-ai";
import { openapiFromMiddleware } from "x402-openapi";

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

// === Route config ===

const SYSTEM_PROMPT = `You are a parameter extractor for a GPU provisioning service.
Extract the following from the user's message and return JSON:
- "action": either "create" (provision a new GPU pod) or "status" (check status of an existing pod). Default "create". (required)
- "gpu": GPU type, one of "RTX_A4000", "RTX_3090", "RTX_4090", "A100_80GB". Default "RTX_A4000". (optional)
- "image": Docker image to use. (optional)
- "disk_gb": container disk size in GB, 5-100. Default 20. (optional)
- "pod_id": the pod ID to check status for. Required if action is "status". (optional)

Return ONLY valid JSON, no explanation.
Examples:
- {"action": "create", "gpu": "RTX_4090"}
- {"action": "status", "pod_id": "abc123"}
- {"action": "create", "gpu": "A100_80GB", "disk_gb": 50}`;

const ROUTES = {
  "POST /": {
    accepts: [{ scheme: "exact", price: "$1.00", network: "eip155:8453", payTo: "0x0" as `0x${string}` }],
    description: "Provision an on-demand GPU instance or check pod status. Send {\"input\": \"your request\"}",
    mimeType: "application/json",
    extensions: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            body: {
              input: { type: "string", description: "Describe what you want: create a GPU pod or check status of an existing one", required: true },
            },
          },
          output: { type: "json" },
        },
        schema: {
          properties: {
            input: {
              properties: { method: { type: "string", enum: ["POST"] } },
              required: ["method"],
            },
          },
        },
      },
    },
  },
};

app.use(
  cdpPaymentMiddleware((env) => ({
    "POST /": { ...ROUTES["POST /"], accepts: [{ ...ROUTES["POST /"].accepts[0], payTo: env.SERVER_ADDRESS as `0x${string}` }] },
  }))
);

app.post("/", async (c) => {
  const body = await c.req.json<{ input?: string }>();
  if (!body?.input) {
    return c.json({ error: "Missing 'input' field" }, 400);
  }

  const params = await extractParams(c.env.CF_GATEWAY_TOKEN, SYSTEM_PROMPT, body.input);
  const action = ((params.action as string) || "create").toLowerCase();

  if (action === "status") {
    const podId = params.pod_id as string;
    if (!podId) {
      return c.json({ error: "Could not determine pod_id to check status" }, 400);
    }
    const provider = getProvider(c.env);
    try {
      const result = await provider.status(c.env, podId);
      return c.json(result);
    } catch (err: any) {
      const status = err.message.includes("not found") ? 404 : 502;
      return c.json({ error: err.message }, status);
    }
  }

  // Default: create
  const provider = getProvider(c.env);

  const gpuKey = (params.gpu as string) || "RTX_A4000";
  if (!provider.gpus[gpuKey]) {
    return c.json(
      { error: `Invalid GPU type '${gpuKey}'. Must be one of: ${Object.keys(provider.gpus).join(", ")}` },
      400
    );
  }

  const image = (params.image as string) || provider.defaultImage;
  const diskGb = Math.min(Math.max(Number(params.disk_gb) || 20, 5), 100);

  try {
    const result = await provider.create(c.env, { gpu: gpuKey, image, disk_gb: diskGb });
    return c.json({ ...result, provider: c.env.PROVIDER || "runpod" });
  } catch (err: any) {
    return c.json({ error: "Failed to create GPU pod", details: err.message }, 502);
  }
});

// === DELETE /destroy/:pod_id (free) ===

app.delete("/destroy/:pod_id", async (c) => {
  const provider = getProvider(c.env);
  try {
    await provider.destroy(c.env, c.req.param("pod_id"));
    return c.json({ destroyed: true, pod_id: c.req.param("pod_id") });
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

app.get("/.well-known/openapi.json", openapiFromMiddleware("x402 GPU", "gpu.camelai.io", ROUTES));

app.get("/", (c) => {
  const provider = getProvider(c.env);
  return c.json({
    service: "x402-gpu",
    description: 'On-demand GPU instances. Send POST / with {"input": "create an RTX 4090 pod"}',
    provider: c.env.PROVIDER || "runpod",
    available_providers: Object.keys(providers),
    gpu_options: Object.keys(provider.gpus),
    price: "$1.00 per request (Base mainnet)",
    endpoints: {
      "POST /": "$1.00",
      "DELETE /destroy/:pod_id": "free",
    },
  });
});

export default app;
