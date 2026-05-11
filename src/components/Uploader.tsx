import React, { useState, useRef, useEffect } from 'react';
import { Upload, Loader2, CheckCircle2, ChevronLeft, ChevronRight, Save, Pause, Play, Square, AlertCircle, Trash2 } from 'lucide-react';
import { motion } from 'motion/react';
import { getPdfDocument, getPageAsImage, cropImage } from '../lib/pdfUtils';
import { ai, MODELS } from '../lib/gemini';
import { Paper, PageData, DocumentElement } from '../types';
import { savePaperToDb } from '../lib/db';
import JSZip from 'jszip';
import mammoth from 'mammoth';

interface UploaderProps {
  onComplete: (paper: Paper) => void;
  onCancel: () => void;
}

export default function Uploader({ onComplete, onCancel }: UploaderProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<'idle' | 'processing' | 'review'>('idle');
  const [isPaused, setIsPaused] = useState(false);
  const stopRef = useRef(false);
  const isPausedRef = useRef(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, message: '', fileIndex: 0 });
  const [processedPapers, setProcessedPapers] = useState<Paper[]>([]);
  const [currentReviewIndex, setCurrentReviewIndex] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);

  const [viewMode, setViewMode] = useState<'detail' | 'tabular'>('detail');

  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  const handleFileSelection = async (selectedFiles: File[]) => {
    const processedFiles: File[] = [];
    for (const f of selectedFiles) {
      if (f.name.toLowerCase().endsWith('.zip')) {
        try {
          const zip = await JSZip.loadAsync(f);
          for (const [path, zFile] of Object.entries(zip.files)) {
            const isSupported = path.toLowerCase().endsWith('.pdf') || 
                               path.toLowerCase().endsWith('.docx') || 
                               path.match(/\.(jpg|jpeg|png|webp)$/i);
            if (!zFile.dir && isSupported) {
              const blob = await zFile.async('blob');
              let mime = blob.type;
              if (!mime) {
                if (path.toLowerCase().endsWith('.pdf')) mime = 'application/pdf';
                else if (path.toLowerCase().endsWith('.docx')) mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
                else if (path.match(/\.(jpg|jpeg)$/i)) mime = 'image/jpeg';
                else if (path.match(/\.png$/i)) mime = 'image/png';
              }
              const fileName = path.split('/').pop() || path;
              processedFiles.push(new File([blob], fileName, { type: mime }));
            }
          }
        } catch (err) {
          console.error("ZIP extraction failed", err);
        }
      } else if (f.type === 'application/pdf' || 
                 f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
                 f.type.startsWith('image/') ||
                 f.name.toLowerCase().endsWith('.docx')) {
        processedFiles.push(f);
      }
    }
    setFiles(prev => [...prev, ...processedFiles].slice(0, 500)); // Increased limit to 500 for the user's batch
  };

  const processBatch = async () => {
    if (files.length === 0) return;
    setStatus('processing');
    setIsPaused(false);
    stopRef.current = false;
    setCurrentReviewIndex(0);
    setProgress({ current: 0, total: 0, message: 'Warming up pipeline...', fileIndex: 0 });
    const results: Paper[] = [];
    setErrors([]);

    console.log(`[Batch] Starting with ${files.length} documents`);

    for (let fIdx = 0; fIdx < files.length; fIdx++) {
      if (stopRef.current) break;
      
      // Wait for pause
      while (isPausedRef.current && !stopRef.current) {
        await new Promise(r => setTimeout(r, 1000));
      }

      if (stopRef.current) break;

      const file = files[fIdx];
      setProgress(prev => ({ ...prev, message: `Preprocessing: ${file.name} (Loading PDF...)`, fileIndex: fIdx }));

      try {
        // Small stagger to avoid overwhelming the system
        await new Promise(r => setTimeout(r, 500));
        
        let paperMetadata: any = { institution: 'Auto-Extracted' };
        let pagesResults: PageData[] = [];

        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
          // Timeout protection for PDF loading
          const pdfPromise = getPdfDocument(file);
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error("PDF Loading Timeout")), 30000)
          );
          
          const pdf = await Promise.race([pdfPromise, timeoutPromise]) as any;
          const numPages = pdf.numPages;
          
          // CONCURRENCY LIMIT: Process up to 2 pages at once for stability in large batches
          const CONCURRENCY = 2;
          
          for (let i = 1; i <= numPages; i += CONCURRENCY) {
            if (stopRef.current) break;
            
            // Wait for pause
            while (isPausedRef.current && !stopRef.current) {
              await new Promise(r => setTimeout(r, 500));
            }
            if (stopRef.current) break;

            const chunk = Array.from({ length: Math.min(CONCURRENCY, numPages - i + 1) }, (_, idx) => i + idx);
            
            setProgress({ 
              current: i, 
              total: numPages, 
              message: `Extracting: ${file.name} (P. ${i}-${Math.min(i + CONCURRENCY - 1, numPages)})`, 
              fileIndex: fIdx 
            });

            const chunkResults = await Promise.all(chunk.map(async (pNum) => {
              try {
                if (stopRef.current) return null;

                // Timeout for page image generation
                const imgPromise = getPageAsImage(pdf, pNum);
                const pageImg = await Promise.race([
                  imgPromise,
                  new Promise((_, reject) => setTimeout(() => reject(new Error("Image Render Timeout")), 60000))
                ]) as any;
                
                // Timeout for Gemini extraction
                const extractPromise = extractPageData(pageImg, pNum, pNum === 1);
                const pageData = await Promise.race([
                  extractPromise,
                  new Promise((_, reject) => setTimeout(() => reject(new Error("AI Extraction Timeout")), 120000))
                ]) as any;
                
                pageData.originalUrl = pageImg.url; // Use local base64 instead of server API
                return pageData;
              } catch (err: any) {
                console.error(`Page ${pNum} extraction failed:`, err);
                setErrors(prev => [...prev, `[${file.name} P.${pNum}]: ${err.message || 'Page crash'}`]);
                return null;
              }
            }));

            pagesResults.push(...chunkResults.filter((p): p is PageData => p !== null));
          }

          // Cleanup PDF memory to prevent freezing on large batches
          try {
            if (pdf && typeof pdf.destroy === 'function') {
              await pdf.destroy();
            }
          } catch (e) {
            console.error("PDF cleanup failed", e);
          }

          // Sort by page number
          pagesResults.sort((a, b) => a.pageNumber - b.pageNumber);
          const firstPageMeta = pagesResults.find(p => p.pageNumber === 1)?.metadata;
          if (firstPageMeta) paperMetadata = { ...paperMetadata, ...firstPageMeta };

        } else if (file.name.toLowerCase().endsWith('.docx') || file.type.includes('word')) {
          setProgress({ current: 1, total: 1, message: `Extracting Text: ${file.name}`, fileIndex: fIdx });
          const arrayBuffer = await file.arrayBuffer();
          const docRes = await mammoth.extractRawText({ arrayBuffer });
          const text = docRes.value;
          const pageData = await extractDocxData(text, file.name);
          if (pageData.metadata) paperMetadata = { ...paperMetadata, ...pageData.metadata };
          pagesResults.push(pageData);
        } else {
          // Handle single image
          const reader = new FileReader();
          const pageImg = await new Promise<{url: string, width: number, height: number}>((resolve, reject) => {
            reader.onload = (e) => {
              const img = new Image();
              img.onload = () => resolve({ url: e.target?.result as string, width: img.width, height: img.height });
              img.onerror = () => reject(new Error("Failed to decode image"));
              img.src = e.target?.result as string;
            };
            reader.onerror = () => reject(new Error("FileReader failed"));
            reader.readAsDataURL(file);
          });
          const pageData = await extractPageData(pageImg, 1, true);
          if (pageData.metadata) paperMetadata = { ...paperMetadata, ...pageData.metadata };
          pagesResults.push(pageData);
        }

        if (stopRef.current) break;

        const newPaper: Paper = {
          id: `EXT-${Date.now()}-${fIdx}-${Math.random().toString(36).substring(7)}`,
          title: paperMetadata.unitName || file.name.replace(/\.[^/.]+$/, ""),
          date: Date.now(),
          pages: pagesResults,
          metadata: paperMetadata
        };

        // Memory store during batch
        results.push(newPaper);
        setProcessedPapers([...results]);
        await new Promise(r => setTimeout(r, 200));
      } catch (error: any) {
        console.error(`Fatal Pipeline Error at ${files[fIdx].name}:`, error);
        setErrors(prev => [...prev, `CRITICAL: ${error.message || 'Pipeline Stall'}`]);
      }
    }

    setStatus('review');
  };

  const extractDocxData = async (text: string, fileName: string): Promise<PageData> => {
    const response = await ai.models.generateContent({
      model: MODELS.pro,
      contents: [
        {
          parts: [
            { text: `The following text was extracted from an engineering paper (.docx). 
             1. Organize this content into logical document elements: headers, text_blocks, and equations.
             2. FOR EQUATIONS: If the text contains mathematical notation, convert it to proper LaTeX.
             3. EXTRACT METADATA: Identify institution, course, unitCode, unitName, assessmentType, and administeredDate.
             
             Original Text Content:
             ${text.substring(0, 30000)} // Reasonable limit for flash
             
             Return JSON format: { 
               elements: Array<{ type: 'text_block' | 'equation' | 'header', content: string }>,
               metadata?: { institution: string, course: string, unitCode: string, unitName: string, assessmentType: string, administeredDate: string }
             }` }
          ]
        }
      ],
      config: { responseMimeType: 'application/json' }
    });

    const rawData = JSON.parse(response.text);
    const elements: DocumentElement[] = (rawData.elements || []).map((item: any) => ({
      id: Math.random().toString(36).substring(7),
      type: item.type,
      content: item.content || '',
      box_2d: [0, 0, 0, 0], // No spatial data for docx
      metadata: {}
    }));

    return {
      pageNumber: 1,
      layout: elements,
      originalUrl: '', // No visual for docx text-only
      dimensions: { width: 800, height: 1100 },
      metadata: rawData.metadata
    };
  };

  const extractPageData = async (pageImg: {url: string, width: number, height: number}, pageNumber: number, isFirstPage: boolean) => {
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      try {
        const response = await ai.models.generateContent({
          model: MODELS.pro,
          contents: [
            {
              parts: [
                { text: `Analyze this engineering paper page as a SPATIAL SCENE. 
                 1. Segment the page into logical regions: headers, text_blocks, equations, diagrams, and tables.
                 2. IGNORE NOISE: Do not transcribe handwritten scribbles, coffee stains, physical stamps, or non-educational marginalia. Only extract formal typed questions and intended sketches/diagrams.
                 3. For EVERY region, provide its bounding box in [ymin, xmin, ymax, xmax] format (normalized 0-1000).
                 4. For text_blocks and equations, transcribe the content exactly. Equations MUST use LaTeX format properly.
                 5. For diagrams and tables, provide a name (e.g. "Figure 1") and a descriptive label explaining what the diagram represents (e.g., "Piston cylinder with pressure P1").
                 6. Maintain natural document reading order in the array.
                 7. EXTRACT METADATA (SPECIAL): If this is page 1, analyze headers to identify the following:
                    - institution (e.g. "Kenyatta University")
                    - course (e.g. "EEE")
                    - unitCode (e.g. "EEE 313")
                    - unitName (e.g. "Transmission lines and web guides")
                    - assessmentType (e.g. "Test", "Exam", "Part Two")
                    - administeredDate (The exact date found on the paper)
                 
                 Return JSON format: { 
                   elements: Array<{ type: 'text_block' | 'diagram' | 'equation' | 'table' | 'header', box_2d: [number,number,number,number], content: string, label?: string }>,
                   metadata?: { institution: string, course: string, unitCode: string, unitName: string, assessmentType: string, administeredDate: string }
                 }` },
                { inlineData: { data: pageImg.url.split(',')[1], mimeType: 'image/jpeg' } }
              ]
            }
          ],
          config: { responseMimeType: 'application/json' }
        });

        const rawData = JSON.parse(response.text);
        const elements: DocumentElement[] = [];

        for (const item of (rawData.elements || [])) {
          const el: DocumentElement = {
            id: Math.random().toString(36).substring(7),
            type: item.type,
            content: item.content || '',
            box_2d: item.box_2d,
            metadata: { label: item.label }
          };

          if (el.type === 'diagram' || el.type === 'table') {
            try {
              const cropped = await cropImage(pageImg.url, el.box_2d);
              el.metadata!.croppedUrl = cropped;
            } catch (e) {
              console.error("Asset extraction/upload failed", e);
            }
          }
          elements.push(el);
        }

        return {
          pageNumber: pageNumber,
          layout: elements,
          originalUrl: pageImg.url,
          dimensions: { width: pageImg.width, height: pageImg.height },
          metadata: rawData.metadata
        };
      } catch (err) {
        attempts++;
        if (attempts >= maxAttempts) throw err;
        console.warn(`Extraction attempt ${attempts} failed, retrying...`, err);
        await new Promise(r => setTimeout(r, 2000 * attempts)); // Exponential backoff
      }
    }
    throw new Error("Failed to extract page data after multiple attempts");
  };

  const saveAll = async () => {
    try {
      for (const p of processedPapers) {
        await savePaperToDb(p);
      }
      onComplete(processedPapers[0]); 
    } catch (e) {
      console.error(e);
      alert("Vault sync failed.");
    }
  };


  if (status === 'processing') {
    const batchProgress = (progress.fileIndex / files.length) * 100;
    const fileProgress = progress.total > 0 ? (progress.current / progress.total) * 100 : 0;
    const totalNormalized = batchProgress + (fileProgress / files.length);

    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-slate-950 font-sans">
        <div className="w-full max-w-2xl bg-slate-900/50 border border-slate-800 rounded-3xl p-10 relative overflow-hidden backdrop-blur-xl">
          <div className="absolute top-0 right-0 p-8">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse"></div>
              <span className="text-[10px] uppercase tracking-[0.2em] text-indigo-400 font-bold">Extraction Live</span>
            </div>
          </div>

          <div className="mb-12">
            <h2 className="text-3xl font-serif text-slate-100 font-bold mb-2">High-Volume Pipeline</h2>
            <p className="text-sm text-slate-500 font-mono uppercase tracking-widest leading-relaxed">
              Entry {progress.fileIndex + 1} of {files.length} • {progress.message}
            </p>
          </div>
          
          <div className="space-y-10">
            {/* Batch Progress */}
            <div>
              <div className="flex justify-between items-end mb-3">
                <p className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Overall Queue Progress</p>
                <p className="text-2xl font-mono text-slate-100 font-bold">{Math.round(totalNormalized)}%</p>
              </div>
              <div className="w-full h-3 bg-slate-800/50 rounded-full overflow-hidden border border-slate-800">
                <motion.div 
                  className="h-full bg-indigo-600 shadow-[0_0_30px_rgba(79,70,229,0.5)]"
                  animate={{ width: `${totalNormalized}%` }}
                  transition={{ duration: 0.8 }}
                />
              </div>
            </div>

            {/* Current File Progress */}
            <div className="bg-slate-800/30 rounded-2xl p-5 border border-slate-700/50">
               <div className="flex justify-between items-center mb-3">
                  <p className="text-[9px] uppercase font-bold text-slate-400">Current Logic Extraction</p>
                  <p className="text-xs font-mono text-slate-200">{Math.round(fileProgress)}%</p>
               </div>
               <div className="w-full h-1.5 bg-slate-900 rounded-full overflow-hidden">
                <motion.div 
                   className="h-full bg-emerald-500"
                   animate={{ width: `${fileProgress}%` }}
                   transition={{ duration: 0.6 }}
                />
               </div>
            </div>
          </div>

          <div className="mt-12 flex items-center justify-between">
            <div className="flex gap-4">
              <button 
                onClick={() => setIsPaused(!isPaused)}
                className={`flex items-center gap-2 px-6 py-3 rounded-xl border transition-all text-xs font-bold uppercase tracking-widest ${isPaused ? 'bg-indigo-600 text-white border-indigo-500 shadow-lg shadow-indigo-600/30' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}`}
              >
                {isPaused ? <Play size={14} /> : <Pause size={14} />}
                {isPaused ? 'Resume' : 'Pause'}
              </button>
              <button 
                 onClick={() => { 
                   console.log("[UI] Stopping extraction...");
                   stopRef.current = true; 
                   setIsPaused(false); 
                 }}
                 className="flex items-center gap-2 px-6 py-3 bg-red-600/10 border border-red-500/30 text-red-500 rounded-xl hover:bg-red-600 hover:text-white transition-all text-xs font-bold uppercase tracking-widest"
              >
                <Square size={14} /> Stop
              </button>
            </div>

            <div className="text-right">
              <p className="text-[10px] text-slate-600 uppercase font-mono mb-1">Documents Stored</p>
              <p className="text-xl font-mono text-emerald-500 font-bold">{processedPapers.length}</p>
            </div>
          </div>

          {errors.length > 0 && (
            <div className="mt-8 border-t border-slate-800 pt-6">
              <div className="flex items-center gap-2 mb-4 text-red-500">
                <AlertCircle size={14} />
                <p className="text-[10px] font-bold uppercase tracking-widest">Pipeline Warnings</p>
              </div>
              <div className="max-h-24 overflow-y-auto space-y-2 pr-4 custom-scrollbar">
                {errors.map((err, i) => (
                  <p key={i} className="text-[9px] text-red-400/70 font-mono leading-relaxed bg-red-500/5 p-2 rounded border border-red-500/10">
                    {err}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (status === 'review') {
    const [currentPageIdx, setCurrentPageIdx] = useState(0);
    
    if (processedPapers.length === 0) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-8 bg-slate-950">
          <div className="text-center">
            <h2 className="text-xl font-serif text-slate-100 mb-4 font-bold">No Documents Extracted</h2>
            <p className="text-sm text-slate-500 mb-8 max-w-sm mx-auto leading-relaxed">The pipeline was stopped or failed before any papers could be successfully processed. Check warnings below.</p>
            <button onClick={onCancel} className="px-6 py-2 bg-slate-800 text-slate-300 rounded text-xs font-bold uppercase tracking-widest hover:bg-slate-700 transition-all">Return to Dashboard</button>
            
            {errors.length > 0 && (
              <div className="mt-12 text-left bg-slate-900 border border-slate-800 p-6 rounded-xl max-w-lg mx-auto">
                <p className="text-[10px] uppercase tracking-widest text-red-500 font-bold mb-4">Pipeline Crash Logs</p>
                <div className="max-h-48 overflow-y-auto space-y-2 custom-scrollbar pr-4">
                  {errors.map((e, i) => <p key={i} className="text-[9px] font-mono text-red-400/70 border-b border-white/5 pb-2">{e}</p>)}
                </div>
              </div>
            )}
          </div>
        </div>
      );
    }

    if (viewMode === 'tabular') {
      return (
        <div className="h-full flex flex-col bg-slate-950 overflow-hidden font-sans">
          <div className="px-8 py-6 border-b border-slate-800 bg-slate-900/40 flex justify-between items-center">
            <div>
              <h2 className="text-xl font-serif text-slate-100 font-bold mb-1">Batch Dataset View</h2>
              <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">{processedPapers.length} Documents in current batch</p>
            </div>
            <div className="flex gap-4">
              <button 
                onClick={() => setViewMode('detail')}
                className="px-6 py-2 bg-slate-800 text-slate-300 rounded text-[10px] font-bold uppercase tracking-widest hover:bg-slate-700 transition-all border border-slate-700"
              >
                Switch to Detail Review
              </button>
              <button onClick={saveAll} className="px-6 py-2 bg-indigo-600 text-white rounded text-[10px] font-bold uppercase tracking-widest hover:bg-indigo-500 transition-all shadow-lg shadow-indigo-600/20">
                Commit All Documents
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-auto p-8 custom-scrollbar">
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-left border-b border-slate-800">
                  <th className="pb-4 px-4 text-[9px] uppercase tracking-widest text-slate-500 font-bold">Paper ID</th>
                  <th className="pb-4 px-4 text-[9px] uppercase tracking-widest text-slate-500 font-bold">University / Unit</th>
                  <th className="pb-4 px-4 text-[9px] uppercase tracking-widest text-slate-500 font-bold">Content Preview</th>
                  <th className="pb-4 px-4 text-[9px] uppercase tracking-widest text-slate-500 font-bold">Asset Nodes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {processedPapers.map((paper, pIdx) => (
                  <tr key={pIdx} className="hover:bg-slate-900/20 transition-colors group">
                    <td className="py-6 px-4 align-top">
                      <p className="text-[10px] font-mono text-slate-400 group-hover:text-indigo-400 transition-colors mb-1">{paper.id.substring(0, 12)}...</p>
                      <span className="text-[9px] px-2 py-0.5 bg-slate-800 rounded text-slate-500 font-mono">PDF v1.0</span>
                    </td>
                    <td className="py-6 px-4 align-top max-w-xs">
                      <h4 className="text-slate-100 font-bold text-xs mb-1">{paper.title}</h4>
                      <p className="text-[10px] text-slate-500 italic">{paper.metadata.institution}</p>
                      <p className="text-[9px] text-slate-600 mt-2 font-mono uppercase tracking-widest">{paper.metadata.course} // {paper.metadata.unitCode}</p>
                    </td>
                    <td className="py-6 px-4 align-top max-w-md">
                      <div className="text-[10px] text-slate-400 line-clamp-4 leading-relaxed font-serif">
                        {paper.pages[0]?.layout.slice(0, 5).map(el => el.content).join(' ')}...
                      </div>
                    </td>
                    <td className="py-6 px-4 align-top">
                      <div className="flex flex-wrap gap-2">
                        {paper.pages.flatMap(p => p.layout).filter(el => el.type === 'diagram' || el.type === 'table').slice(0, 3).map((el, i) => (
                          <div key={i} className="w-12 h-12 bg-slate-800 rounded border border-slate-700 overflow-hidden relative group/asset">
                            {el.metadata?.croppedUrl && <img src={el.metadata.croppedUrl} className="w-full h-full object-contain" />}
                            <div className="absolute inset-0 bg-indigo-600/40 opacity-0 group-hover/asset:opacity-100 transition-opacity" />
                          </div>
                        ))}
                        {paper.pages.flatMap(p => p.layout).filter(el => el.type === 'diagram' || el.type === 'table').length > 3 && (
                          <div className="w-12 h-12 flex items-center justify-center text-[10px] font-mono text-slate-600 bg-slate-900 border border-slate-800 rounded">
                            +{paper.pages.flatMap(p => p.layout).filter(el => el.type === 'diagram' || el.type === 'table').length - 3}
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }

    const paper = processedPapers[currentReviewIndex];
    const currentPage = paper.pages[currentPageIdx] || { layout: [], originalUrl: '', pageNumber: 1, dimensions: { width: 800, height: 1100 } };
    const visualElements = currentPage.layout.filter(el => el.type === 'diagram' || el.type === 'table');
    const textElements = currentPage.layout.filter(el => el.type === 'text_block' || el.type === 'equation' || el.type === 'header');

    return (
      <div className="h-full flex flex-col overflow-hidden bg-slate-950">
        <div className="flex justify-between items-center px-8 py-4 border-b border-slate-800 bg-slate-900/30">
          <div className="flex items-center gap-6">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold mb-1">Batch Review: {currentReviewIndex + 1} / {processedPapers.length}</p>
              <h2 className="text-xl font-serif text-slate-100 font-bold">{paper.title}</h2>
            </div>
          </div>
          <div className="flex gap-4">
             <button 
              onClick={() => setViewMode('tabular')}
              className="text-xs font-mono uppercase px-4 py-2 text-slate-400 hover:text-indigo-400 transition-colors border border-slate-800 rounded hover:bg-slate-800"
            >
              Tabular View
            </button>
             <button 
              disabled={currentReviewIndex === 0}
              onClick={() => { setCurrentReviewIndex(prev => prev-1); setCurrentPageIdx(0); }}
              className="text-xs font-mono uppercase px-4 py-2 text-slate-400 hover:text-slate-100 transition-colors disabled:opacity-20"
            >
              Prev Document
            </button>
            <button 
              disabled={currentReviewIndex === processedPapers.length - 1}
              onClick={() => { setCurrentReviewIndex(prev => prev+1); setCurrentPageIdx(0); }}
              className="text-xs font-mono uppercase px-4 py-2 text-slate-400 hover:text-slate-100 transition-colors disabled:opacity-20"
            >
              Next Document
            </button>
            <div className="w-[1px] h-6 bg-slate-800 mx-2 self-center"></div>
            <button onClick={saveAll} className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold uppercase tracking-widest px-6 py-2.5 rounded flex items-center gap-2 transition-all shadow-lg shadow-indigo-600/20">
              <Save size={14} /> Commit All {processedPapers.length}
            </button>
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <aside className="w-80 border-r border-slate-800 bg-slate-900/20 flex flex-col p-6 overflow-y-auto shrink-0">
            <div className="mb-8">
              <p className="text-[10px] uppercase tracking-widest text-indigo-400 font-bold mb-4">Paper Profile</p>
              <div className="space-y-4">
                <div>
                  <label className="text-[8px] text-slate-500 uppercase font-mono">Institution</label>
                  <input 
                    type="text" 
                    value={paper.metadata.institution || ''} 
                    onChange={(e) => {
                      const updated = [...processedPapers];
                      updated[currentReviewIndex].metadata.institution = e.target.value;
                      setProcessedPapers(updated);
                    }}
                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-[10px] text-slate-200 focus:border-indigo-500 outline-none transition-colors"
                  />
                </div>
                <div>
                  <label className="text-[8px] text-slate-500 uppercase font-mono">Unit Code & Name</label>
                  <div className="flex gap-2">
                    <input 
                      type="text" 
                      placeholder="Code"
                      value={paper.metadata.unitCode || ''} 
                      onChange={(e) => {
                        const updated = [...processedPapers];
                        updated[currentReviewIndex].metadata.unitCode = e.target.value;
                        setProcessedPapers(updated);
                      }}
                      className="w-20 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-[10px] text-slate-200 focus:border-indigo-500 outline-none transition-colors"
                    />
                    <input 
                      type="text" 
                      placeholder="Name"
                      value={paper.metadata.unitName || ''} 
                      onChange={(e) => {
                        const updated = [...processedPapers];
                        updated[currentReviewIndex].metadata.unitName = e.target.value;
                        updated[currentReviewIndex].title = e.target.value;
                        setProcessedPapers(updated);
                      }}
                      className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-[10px] text-slate-200 focus:border-indigo-500 outline-none transition-colors"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[8px] text-slate-500 uppercase font-mono">Course</label>
                    <input 
                      type="text" 
                      value={paper.metadata.course || ''} 
                      onChange={(e) => {
                        const updated = [...processedPapers];
                        updated[currentReviewIndex].metadata.course = e.target.value;
                        setProcessedPapers(updated);
                      }}
                      className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-[10px] text-slate-200 focus:border-indigo-500 outline-none transition-colors"
                    />
                  </div>
                  <div>
                    <label className="text-[8px] text-slate-500 uppercase font-mono">Type</label>
                    <input 
                      type="text" 
                      value={paper.metadata.assessmentType || ''} 
                      onChange={(e) => {
                        const updated = [...processedPapers];
                        updated[currentReviewIndex].metadata.assessmentType = e.target.value;
                        setProcessedPapers(updated);
                      }}
                      className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-[10px] text-slate-200 focus:border-indigo-500 outline-none transition-colors"
                    />
                  </div>
                </div>
              </div>
            </div>

            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold mb-4">Vision Analysis</p>
            <div className="relative border border-slate-700 bg-white shadow-2xl rounded p-1 mb-6">
              <div className="aspect-[3/4] relative overflow-hidden bg-slate-100 rounded-sm">
                <img src={currentPage.originalUrl} className="w-full h-full object-contain pointer-events-none" />
                {currentPage.layout.map((el, idx) => (
                  <div 
                    key={idx}
                    style={{
                      position: 'absolute',
                      top: `${el.box_2d[0] / 10}%`,
                      left: `${el.box_2d[1] / 10}%`,
                      width: `${(el.box_2d[3] - el.box_2d[1]) / 10}%`,
                      height: `${(el.box_2d[2] - el.box_2d[0]) / 10}%`,
                      border: `2px solid ${el.type === 'diagram' ? '#6366f1' : el.type === 'equation' ? '#ec4899' : '#94a3b8'}`,
                      backgroundColor: el.type === 'diagram' ? 'rgba(99, 102, 241, 0.1)' : 'transparent'
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="flex justify-between items-center bg-slate-800/50 p-2 rounded border border-slate-700 font-mono text-[10px] text-slate-400">
              <button disabled={currentPageIdx === 0} onClick={() => setCurrentPageIdx(prev => prev - 1)} className="hover:text-indigo-400 disabled:opacity-20 flex items-center gap-1 transition-colors">
                <ChevronLeft size={12} /> PREV
              </button>
              <span className="text-slate-300">P. {currentPage.pageNumber} / {paper.pages.length}</span>
              <button disabled={currentPageIdx === paper.pages.length - 1} onClick={() => setCurrentPageIdx(prev => prev + 1)} className="hover:text-indigo-400 disabled:opacity-20 flex items-center gap-1 transition-colors">
                NEXT <ChevronRight size={12} />
              </button>
            </div>
          </aside>

          <main className="flex-1 p-8 overflow-y-auto">
            <div className="grid grid-cols-2 gap-8">
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                  <h3 className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Transcription Output</h3>
                  <span className="text-[9px] text-indigo-400 font-mono bg-indigo-500/10 px-2 py-0.5 rounded uppercase">Spatial Ordered</span>
                </div>
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-inner space-y-4">
                  {textElements.map((el, idx) => (
                    <div key={idx} className={el.type === 'header' ? 'border-b border-slate-800 pb-2 mb-4' : ''}>
                      {el.type === 'header' ? (
                        <h4 className="text-sm font-bold text-slate-100 italic font-serif">{el.content}</h4>
                      ) : (
                        <div className={`text-sm leading-relaxed ${el.type === 'equation' ? 'bg-indigo-500/5 p-2 rounded font-mono text-indigo-300 border border-indigo-500/10' : 'text-slate-300'}`}>
                          {el.content}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                  <h3 className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Extracted Assets</h3>
                  <span className="text-[9px] text-slate-500 font-mono">{visualElements.length} DETECTED</span>
                </div>
                <div className="grid grid-cols-1 gap-4">
                  {visualElements.map((el, idx) => (
                    <div key={idx} className="bg-slate-900 border border-slate-800 rounded-lg p-3 group hover:border-indigo-500/50 transition-all shadow-sm">
                      <div className="flex justify-between items-start mb-3">
                        <span className="text-[9px] font-mono text-slate-300 font-bold uppercase">{el.metadata?.label || el.type}</span>
                        <div className="w-1.5 h-1.5 rounded-full bg-indigo-500"></div>
                      </div>
                      <div className="aspect-video bg-slate-800 rounded border border-slate-700/50 overflow-hidden flex items-center justify-center p-2">
                        {el.metadata?.croppedUrl ? (
                          <img src={el.metadata.croppedUrl} className="max-w-full max-h-full object-contain" />
                        ) : (
                          <div className="w-12 h-12 border border-slate-600 border-dashed rounded opacity-30"></div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-slate-950 p-8 items-center justify-center">
      <div className="max-w-2xl w-full">
        <div className="mb-12 text-center">
          <h1 className="text-4xl font-serif text-slate-100 font-bold mb-3 tracking-tight">Structured Pipeline</h1>
          <p className="text-xs font-mono text-slate-500 uppercase tracking-widest">Select up to 20 documents for automated feature extraction</p>
        </div>

        <div 
          className="aspect-video border-2 border-dashed border-slate-800 bg-slate-900/30 rounded-2xl flex flex-col items-center justify-center hover:bg-slate-900/50 hover:border-indigo-500/50 transition-all cursor-pointer group shadow-2xl relative overflow-hidden"
          onDragOver={(e) => e.preventDefault()}
          onDrop={async (e) => {
            e.preventDefault();
            await handleFileSelection(Array.from(e.dataTransfer.files));
          }}
          onClick={() => document.getElementById('file-input')?.click()}
        >
          <div className="absolute inset-0 bg-[radial-gradient(#1e293b_1px,transparent_1px)] [background-size:16px_16px] opacity-10"></div>
          
          <input 
            id="file-input"
            type="file" 
            multiple
            className="hidden" 
            accept=".pdf,image/*,.zip" 
            onChange={async (e) => {
              if (e.target.files) {
                await handleFileSelection(Array.from(e.target.files));
              }
            }}
          />
          
          {files.length > 0 ? (
            <div className="text-center relative z-10 w-full px-8">
              <div className="w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center mx-auto mb-6 border border-emerald-500/30 shadow-[0_0_20px_rgba(16,185,129,0.1)]">
                <CheckCircle2 className="text-emerald-500" size={32} />
              </div>
              <p className="text-slate-100 font-medium text-lg mb-1">{files.length} Documents Selected</p>
              <div className="flex flex-wrap gap-2 justify-center mt-4 max-h-24 overflow-y-auto p-2 border border-slate-800/50 rounded flex-1">
                {files.map((f, i) => (
                  <span key={i} className="text-[8px] bg-slate-800 px-2 py-1 rounded border border-slate-700 text-slate-400 font-mono flex items-center gap-1">
                    {f.name.substring(0, 10)}... {f.name.split('.').pop()?.toUpperCase()}
                  </span>
                ))}
              </div>
              
              <div className="mt-10 flex gap-4 justify-center">
                <button 
                  onClick={(e) => { e.stopPropagation(); setFiles([]); }}
                  className="px-6 py-2.5 border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-bold uppercase tracking-widest rounded transition-all"
                >
                  Clear Queue
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); processBatch(); }}
                  className="px-8 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-bold uppercase tracking-widest rounded transition-all shadow-lg shadow-indigo-600/40"
                >
                  Init Batch Extraction
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center relative z-10 flex flex-col items-center">
              <div className="w-20 h-20 bg-slate-800 rounded-3xl flex items-center justify-center mb-8 border border-slate-700 group-hover:bg-slate-700 group-hover:scale-110 transition-all shadow-xl">
                <Upload className="text-slate-500 group-hover:text-indigo-400" size={32} />
              </div>
              <p className="text-slate-300 font-mono text-[11px] uppercase tracking-[0.2em]">Drop PDFs / Images TO Queue</p>
              <div className="mt-6 flex items-center gap-3">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-800"></span>
                <span className="text-[9px] text-slate-600 font-mono uppercase tracking-widest">Supports Multi-select up to 20</span>
                <span className="w-1.5 h-1.5 rounded-full bg-slate-800"></span>
              </div>
            </div>
          )}
        </div>
        
        <div className="mt-8 flex justify-center">
           <button onClick={onCancel} className="text-[9px] font-mono uppercase text-slate-600 hover:text-slate-400 transition-colors tracking-widest">Return to Base</button>
        </div>
      </div>
    </div>
  );
}
