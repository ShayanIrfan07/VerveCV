export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export interface HealthLiveResponse {
  status: "live";
}

export interface HealthReadyResponse {
  status: "ready";
}
