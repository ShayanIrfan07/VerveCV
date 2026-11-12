export interface PdfjsTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
}

export interface PdfjsPage {
  getViewport(params: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: unknown[] }>;
}

export interface PdfjsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfjsPage>;
  cleanup?: () => Promise<void>;
}

export interface PdfjsLoadingTask {
  promise: Promise<PdfjsDocument>;
  destroy(): void;
}

export interface PdfjsModule {
  getDocument(params: Record<string, unknown>): PdfjsLoadingTask;
  GlobalWorkerOptions: { workerSrc: string };
}
