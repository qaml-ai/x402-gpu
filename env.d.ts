interface Env {
  SERVER_ADDRESS: string;

  // Provider: set PROVIDER to switch backends ("runpod" | "lambda" | etc.)
  PROVIDER: string;

  // RunPod
  RUNPOD_API_KEY: string;

  // Lambda Labs (future)
  LAMBDA_API_KEY: string;
}
