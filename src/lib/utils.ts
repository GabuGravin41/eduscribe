import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { Paper } from '../types';

/**
 * Flattens hierarchical paper data into a tabular CSV format
 */
export async function downloadTabularCSV(papers: Paper[]) {
  const headers = [
    'Paper ID',
    'Title',
    'Date Added',
    'Institution',
    'Course',
    'Unit Code',
    'Unit Name',
    'Assessment Type',
    'Administered Date',
    'Page Number',
    'Element ID',
    'Element Type',
    'Content (Transcription)',
    'Image Asset URL',
    'Solution'
  ];

  const rows = [];
  rows.push(headers.join(','));

  for (const paper of papers) {
    if (!paper.pages) continue;
    for (const page of paper.pages) {
      if (!page.layout) continue;
      for (const el of page.layout) {
        const row = [
          `"${paper.id}"`,
          `"${(paper.title || '').replace(/"/g, '""')}"`,
          `"${new Date(paper.date).toISOString()}"`,
          `"${(paper.metadata?.institution || '').replace(/"/g, '""')}"`,
          `"${(paper.metadata?.course || '').replace(/"/g, '""')}"`,
          `"${(paper.metadata?.unitCode || '').replace(/"/g, '""')}"`,
          `"${(paper.metadata?.unitName || '').replace(/"/g, '""')}"`,
          `"${(paper.metadata?.assessmentType || '').replace(/"/g, '""')}"`,
          `"${(paper.metadata?.administeredDate || '').replace(/"/g, '""')}"`,
          page.pageNumber,
          `"${el.id}"`,
          `"${el.type}"`,
          `"${(el.content || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`,
          `"${el.metadata?.croppedUrl || ''}"`,
          `"${(el.solution || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`
        ];
        rows.push(row.join(','));
      }
    }
  }

  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  saveAs(blob, `eduscribe_dataset_${Date.now()}.csv`);
}
