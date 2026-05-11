export type ElementType = 'text_block' | 'diagram' | 'table' | 'equation' | 'header' | 'footer' | 'solution_block';

export interface DocumentElement {
  id: string;
  type: ElementType;
  content: string; // Transcribed text or LaTeX
  box_2d: [number, number, number, number]; // [ymin, xmin, ymax, xmax]
  solution?: string; // AI generated solution
  metadata?: {
    label?: string; // Descriptive name for diagrams/tables
    confidence?: number;
    croppedUrl?: string; // For visual assets
  };
}

export interface PageData {
  pageNumber: number;
  layout: DocumentElement[];
  originalUrl: string;
  dimensions: { width: number; height: number };
}

export interface Paper {
  id: string;
  title: string;
  date: string;
  pages: PageData[];
  metadata: {
    institution?: string;      // University (e.g. Kenyatta University)
    course?: string;           // E.g. EEE
    unitCode?: string;         // E.g. EEE 313
    unitName?: string;         // E.g. Transmission lines and web guides
    assessmentType?: string;   // E.g. Test, Exam, Part Two
    administeredDate?: string; // Date on the paper
    author?: string;
    tags?: string[];
  };
}
