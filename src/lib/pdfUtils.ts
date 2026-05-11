import * as pdfjs from 'pdfjs-dist';

// Use standard Vite integration for worker
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString();

console.log("[PDF] Initializing local worker");

export interface PdfPageImage {
  url: string;
  width: number;
  height: number;
}

export async function getPdfDocument(file: File) {
  console.log(`[PDF] Loading document: ${file.name} (${file.size} bytes)`);
  try {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjs.getDocument({ 
      data: arrayBuffer,
      useWorkerFetch: true,
      isEvalSupported: false,
    });
    
    return await loadingTask.promise;
  } catch (err) {
    console.error("[PDF] Failed to load document:", err);
    throw err;
  }
}

export async function getPageAsImage(pdf: any, pageNumber: number): Promise<PdfPageImage> {
  const page = await pdf.getPage(pageNumber);
  
  // Dynamic scaling: aim for ~2000px longest side
  const baseViewport = page.getViewport({ scale: 1 });
  const maxSide = Math.max(baseViewport.width, baseViewport.height);
  const targetDimension = 2000;
  const optimalScale = targetDimension / maxSide;
  const scale = Math.min(Math.max(optimalScale, 1.0), 2.5); // Clamp scale between 1.0 and 2.5

  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  if (!context) throw new Error('Canvas context failed');

  canvas.height = viewport.height;
  canvas.width = viewport.width;

  await page.render({
    canvasContext: context,
    viewport: viewport,
    canvas: canvas
  }).promise;

  const url = canvas.toDataURL('image/jpeg', 0.75); // Slightly higher quality for engineering details
  const width = viewport.width;
  const height = viewport.height;
  
  // Cleanup
  canvas.width = 0;
  canvas.height = 0;

  return { url, width, height };
}

export async function convertPdfToImages(file: File): Promise<PdfPageImage[]> {
  const pdf = await getPdfDocument(file);
  const pages: PdfPageImage[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    pages.push(await getPageAsImage(pdf, i));
  }
  return pages;
}

export async function cropImage(base64: string, box2d: [number, number, number, number]): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const [ymin, xmin, ymax, xmax] = box2d;
      
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject('No context');

      // Normalized 1000 to pixels
      const x = (xmin / 1000) * img.width;
      const y = (ymin / 1000) * img.height;
      const width = ((xmax - xmin) / 1000) * img.width;
      const height = ((ymax - ymin) / 1000) * img.height;

      canvas.width = width;
      canvas.height = height;

      ctx.drawImage(img, x, y, width, height, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = reject;
    img.src = base64;
  });
}
