import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, FileText, Download, Share2, Layers, Loader2, Zap, CheckCircle2, ShieldAlert } from 'lucide-react';
import { motion } from 'motion/react';
import { Paper, DocumentElement } from '../types';
import JSZip from 'jszip';
import { savePaperToDb } from '../lib/db';
import { saveAs } from 'file-saver';
import { solveElement } from '../lib/solver';

interface PaperDetailProps {
  paper: Paper;
  onBack: () => void;
  onUpdate: (updated: Paper) => void;
}

export default function PaperDetail({ paper, onBack, onUpdate }: PaperDetailProps) {
  const [viewMode, setViewMode] = useState<'document' | 'assets'>('document');
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [solvingIds, setSolvingIds] = useState<Set<string>>(new Set());
  const [solvingPaper, setSolvingPaper] = useState(false);
  const currentPage = paper.pages[currentPageIndex];

  // Logic to gather all assets from all pages
  const allAssets = paper.pages.flatMap(p => 
    p.layout
      .filter(el => el.type === 'diagram' || el.type === 'table')
      .map(el => ({ ...el, pageNumber: p.pageNumber }))
  );

  const handleSolveElement = async (element: DocumentElement, silent = false) => {
    if (solvingIds.has(element.id)) return;
    
    if (!silent) setSolvingIds(prev => new Set(prev).add(element.id));
    try {
      const solution = await solveElement(element);
      
      const updatedPaper = { ...paper };
      updatedPaper.pages = paper.pages.map(p => ({
        ...p,
        layout: p.layout.map(el => el.id === element.id ? { ...el, solution } : el)
      }));
      
      onUpdate(updatedPaper);
      
      // Persist to DB
      await savePaperToDb(updatedPaper);
    } catch (e) {
      console.error(e);
    } finally {
      if (!silent) {
        setSolvingIds(prev => {
          const next = new Set(prev);
          next.delete(element.id);
          return next;
        });
      }
    }
  };

  const handleSolveFullPaper = async () => {
    setSolvingPaper(true);
    try {
      for (const page of paper.pages) {
        const solvable = page.layout.filter(el => 
          (el.type === 'text_block' || el.type === 'equation') && !el.solution
        );
        for (const el of solvable) {
          await handleSolveElement(el, true);
        }
      }
    } catch (err) {
      console.error("Full paper solve failed", err);
    } finally {
      setSolvingPaper(false);
    }
  };

  const handleSolveAll = async () => {
    const solvable = currentPage.layout.filter(el => 
      (el.type === 'text_block' || el.type === 'equation') && !el.solution
    );
    
    for (const el of solvable) {
      await handleSolveElement(el);
    }
  };

  const handleDownloadPack = async () => {
    setExporting(true);
    try {
      const zip = new JSZip();
      const assetsFolder = zip.folder("assets");
      const solutionsFolder = zip.folder("solutions");
      
      let markdownContent = `# ${paper.title}\n\n`;
      markdownContent += `Date: ${new Date(paper.date).toLocaleDateString()}\n`;
      markdownContent += `ID: ${paper.id}\n\n---\n\n`;

      for (const page of paper.pages) {
        markdownContent += `## Page ${page.pageNumber}\n\n`;
        for (const el of page.layout) {
          if (el.type === 'header') {
            markdownContent += `### ${el.content}\n\n`;
          } else if (el.type === 'equation') {
            markdownContent += `\n$$\n${el.content}\n$$\n\n`;
          } else if (el.type === 'diagram' || el.type === 'table') {
            const assetName = `${el.type}_${page.pageNumber}_${el.id}.jpg`;
            markdownContent += `![${el.metadata?.label || el.id}](./assets/${assetName})\n\n`;
            markdownContent += `*${el.metadata?.label || el.id}*\n\n`;

            if (el.metadata?.croppedUrl) {
                const response = await fetch(el.metadata.croppedUrl);
                const blob = await response.blob();
                assetsFolder?.file(assetName, blob);
            }
          } else {
            markdownContent += `${el.content}\n\n`;
          }
          
          if (el.solution) {
            markdownContent += `> **Solution:**\n${el.solution.split('\n').map(l => `> ${l}`).join('\n')}\n\n`;
            solutionsFolder?.file(`solution_${el.id}.md`, el.solution);
          }
        }
        markdownContent += `\n---\n\n`;
      }

      zip.file("structured_paper_with_solutions.md", markdownContent);
      zip.file("raw_data.json", JSON.stringify(paper, null, 2));

      const content = await zip.generateAsync({ type: "blob" });
      saveAs(content, `${paper.title.replace(/\s+/g, '_')}_Study_Pack.zip`);
    } catch (e) {
      console.error("Export failed", e);
      alert("Bundle export failed.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-slate-950 overflow-hidden">
      {/* Detail Header */}
      <div className="flex justify-between items-center px-8 py-5 border-b border-slate-800 bg-slate-900/50">
        <div className="flex items-center gap-6">
          <button onClick={onBack} className="w-10 h-10 border border-slate-700 bg-slate-800 rounded-full flex items-center justify-center text-slate-400 hover:text-white transition-all hover:scale-105 shadow-xl">
            <ChevronLeft size={20} />
          </button>
          <div>
            <div className="flex gap-2 mb-1">
              {paper.metadata.institution && (
                <span className="text-[8px] bg-indigo-500/10 text-indigo-400 px-2 py-0.5 rounded uppercase border border-indigo-500/20">{paper.metadata.institution}</span>
              )}
              {paper.metadata.unitCode && (
                <span className="text-[8px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded border border-slate-700">{paper.metadata.unitCode}</span>
              )}
              {paper.metadata.assessmentType && (
                <span className="text-[8px] bg-pink-500/10 text-pink-500 px-2 py-0.5 rounded border border-pink-500/20">{paper.metadata.assessmentType}</span>
              )}
            </div>
            <h1 className="text-2xl font-serif text-slate-100 font-bold">{paper.title}</h1>
            <div className="flex gap-4 text-[10px] font-mono uppercase tracking-widest text-slate-500 mt-1">
              <span>{paper.metadata.course || 'GENERAL'}</span>
              <span>•</span>
              <span>{paper.metadata.administeredDate || new Date(paper.date).toLocaleDateString()}</span>
              <span>•</span>
              <span className="text-indigo-400">STATUS: VERIFIED</span>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <div className="flex bg-slate-900 border border-slate-700 rounded p-1 mr-4">
            <button 
              onClick={() => setViewMode('document')}
              className={`px-4 py-1.5 rounded text-[10px] font-bold uppercase tracking-wider transition-all ${viewMode === 'document' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20' : 'text-slate-500 hover:text-slate-300'}`}
            >
              Document
            </button>
            <button 
              onClick={() => setViewMode('assets')}
              className={`px-4 py-1.5 rounded text-[10px] font-bold uppercase tracking-wider transition-all ${viewMode === 'assets' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20' : 'text-slate-500 hover:text-slate-300'}`}
            >
              Gallery ({allAssets.length})
            </button>
          </div>
          <button 
            onClick={handleSolveFullPaper}
            disabled={solvingPaper}
            className={`flex items-center gap-2 border px-4 py-2.5 rounded text-[10px] font-bold uppercase tracking-widest transition-all font-mono ${solvingPaper ? 'bg-indigo-600/20 border-indigo-500/50 text-indigo-400' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-indigo-400 hover:bg-slate-700'}`}
          >
            {solvingPaper ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
            {solvingPaper ? 'Solving Paper...' : 'Solve Full Paper'}
          </button>
          <button 
            onClick={handleSolveAll}
            className="flex items-center gap-2 bg-slate-800 border border-slate-700 text-indigo-400 px-4 py-2.5 rounded text-[10px] font-bold uppercase tracking-widest hover:bg-slate-700 transition-all font-mono"
          >
            <Zap size={14} className="fill-indigo-400/20" />
            Auto-Solve Page
          </button>
          <button 
            disabled={exporting}
            onClick={handleDownloadPack}
            className="bg-indigo-600 text-white px-6 py-2.5 rounded text-xs font-bold uppercase tracking-widest hover:bg-indigo-500 transition-all shadow-lg shadow-indigo-600/20 flex items-center gap-2 disabled:opacity-50"
          >
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {exporting ? 'Piping Assets...' : 'Export Study Pack'}
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Page Selector Aside */}
        <aside className="w-40 border-r border-slate-800 bg-slate-900/80 flex flex-col items-center py-8 gap-8 overflow-y-auto custom-scrollbar shadow-2xl">
          <div className="text-center px-4 mb-2">
            <p className="text-[10px] font-black text-indigo-500 uppercase tracking-[0.25em] leading-tight">Navigator</p>
            <div className="h-px w-8 bg-slate-800 mx-auto mt-4"></div>
          </div>
          
          <div className="flex flex-col gap-6 w-full items-center px-4">
            {paper.pages.map((p, idx) => (
              <button 
                key={idx}
                onClick={() => {
                  setCurrentPageIndex(idx);
                  setViewMode('document');
                }}
                className={`group flex flex-col items-center w-full transition-all relative ${currentPageIndex === idx && viewMode === 'document' ? 'scale-105' : 'opacity-40 hover:opacity-100 hover:scale-102'}`}
              >
                {currentPageIndex === idx && viewMode === 'document' && (
                  <motion.div layoutId="active-indicator" className="absolute -left-4 top-0 bottom-0 w-1 bg-indigo-500 rounded-r-full shadow-[0_0_15px_rgba(79,70,229,1)]" />
                )}
                
                <div className={`w-24 h-32 rounded-lg overflow-hidden border-2 mb-2 transition-all flex flex-col items-center justify-center relative bg-slate-800/50 ${currentPageIndex === idx && viewMode === 'document' ? 'border-indigo-500 shadow-2xl shadow-indigo-600/20' : 'border-slate-800 hover:border-slate-600'}`}>
                   {/* Mini preview or just larger icon */}
                   <div className="w-full h-full flex flex-col items-center justify-center p-2 opacity-30">
                      <div className="w-full h-1 bg-slate-600 rounded-full mb-1"></div>
                      <div className="w-2/3 h-1 bg-slate-600 rounded-full mb-1 self-start"></div>
                      <div className="w-full h-1 bg-slate-600 rounded-full mb-1"></div>
                      <div className="w-1/2 h-1 bg-slate-600 rounded-full mb-1 self-start"></div>
                   </div>
                   
                  <div className={`absolute inset-0 flex items-center justify-center ${currentPageIndex === idx && viewMode === 'document' ? 'bg-indigo-600/10' : ''}`}>
                    <span className={`text-xl font-serif font-black ${currentPageIndex === idx && viewMode === 'document' ? 'text-indigo-400' : 'text-slate-600'}`}>
                      {p.pageNumber}
                    </span>
                  </div>
                </div>
                <span className={`text-[10px] font-bold uppercase tracking-widest text-center transition-colors ${currentPageIndex === idx && viewMode === 'document' ? 'text-indigo-400' : 'text-slate-500'}`}>
                  Page {p.pageNumber}
                </span>
              </button>
            ))}
          </div>
          
          <div className="mt-auto pt-8 border-t border-slate-800 w-full flex flex-col items-center gap-6 pb-8">
             <button 
              onClick={() => setViewMode('assets')}
              className={`group flex flex-col items-center w-full transition-all ${viewMode === 'assets' ? 'scale-105' : 'opacity-40 hover:opacity-100 hover:scale-102'}`}
             >
                <div className={`w-24 h-24 rounded-2xl border-2 flex items-center justify-center mb-2 transition-all ${viewMode === 'assets' ? 'border-emerald-500 bg-emerald-600/20 text-emerald-400 shadow-2xl shadow-emerald-600/20' : 'border-slate-800 bg-slate-900 text-slate-500 group-hover:border-slate-600 shadow-xl'}`}>
                  <Layers size={32} />
                </div>
                <span className={`text-[10px] font-black uppercase tracking-widest text-center leading-tight transition-colors ${viewMode === 'assets' ? 'text-emerald-400' : 'text-slate-500'}`}>
                  Visual<br/>Vault
                </span>
             </button>
          </div>
        </aside>

        {/* Content Explorer */}
        <main className="flex-1 flex overflow-hidden">
          {viewMode === 'document' ? (
            <section className="flex-1 p-8 overflow-y-auto bg-slate-950/50">
              <div className="flex flex-col gap-10">
                 <div className="flex flex-col gap-4">
                   <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                     <h3 className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Transcription Fragment</h3>
                     <div className="flex items-center gap-2">
                       <div className="w-2 h-2 rounded-full bg-indigo-500"></div>
                       <span className="text-[10px] font-mono text-slate-300">PAGE {currentPage.pageNumber} OF {paper.pages.length}</span>
                     </div>
                   </div>
                   <div className="bg-slate-900/40 rounded-2xl p-8 border border-slate-800/80 shadow-2xl space-y-6">
                     {currentPage.layout.map((el, idx) => (
                       <div key={idx} className={`${el.type === 'header' ? 'border-b border-slate-800 pb-2 mb-6' : ''} group relative`}>
                         {el.type === 'header' ? (
                           <h4 className="text-lg font-bold text-slate-100 italic font-serif">{el.content}</h4>
                         ) : el.type === 'equation' ? (
                           <div className="bg-indigo-500/10 p-4 rounded-xl border border-indigo-500/20 font-mono text-indigo-300 text-center my-4 overflow-x-auto shadow-[0_0_20px_rgba(79,70,229,0.05)]">
                             {el.content}
                           </div>
                         ) : el.type === 'diagram' ? (
                           <div className="my-8 flex flex-col items-center">
                             {el.metadata?.croppedUrl && (
                                <img src={el.metadata.croppedUrl} className="max-w-md border border-slate-800/50 shadow-2xl rounded-lg" />
                             )}
                             <p className="text-[10px] font-mono text-slate-500 mt-2 uppercase tracking-widest">{el.metadata?.label || el.id}</p>
                           </div>
                         ) : (
                           <p className="text-slate-300 leading-relaxed font-sans">{el.content}</p>
                         )}

                         {(el.type === 'text_block' || el.type === 'equation') && (
                           <div className="mt-4 pl-4 border-l-2 border-slate-800 hover:border-indigo-500/50 transition-colors">
                             {!el.solution ? (
                               <button 
                                 onClick={() => handleSolveElement(el)}
                                 disabled={solvingIds.has(el.id)}
                                 className="text-[9px] font-mono font-bold uppercase tracking-widest text-indigo-400 flex items-center gap-2 hover:text-indigo-300 transition-colors disabled:opacity-50"
                               >
                                 {solvingIds.has(el.id) ? (
                                   <><Loader2 size={10} className="animate-spin" /> Computing Solution...</>
                                 ) : (
                                   <><Zap size={10} /> Generate Solution</>
                                 )}
                               </button>
                             ) : (
                               <div className="bg-slate-900/60 rounded-lg p-4 mt-2 border border-slate-800">
                                 <div className="flex items-center gap-2 mb-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-indigo-500"></div>
                                    <span className="text-[9px] font-mono font-bold uppercase tracking-widest text-slate-400">AI Solution Verified</span>
                                 </div>
                                 <div className="text-slate-300 text-sm italic font-mono whitespace-pre-wrap">
                                   {el.solution}
                                 </div>
                               </div>
                             )}
                           </div>
                         )}
                       </div>
                     ))}
                   </div>
                 </div>
              </div>
            </section>
          ) : (
            <section className="flex-1 p-10 overflow-y-auto bg-slate-950">
              <div className="max-w-6xl mx-auto">
                <div className="flex justify-between items-end mb-10 pb-6 border-b border-slate-800">
                  <div>
                    <h2 className="text-3xl font-serif text-white font-bold mb-2">Technical Image Gallery</h2>
                    <p className="text-slate-400 font-mono text-[10px] uppercase tracking-widest">Aggregate of all extracted diagrams, tables, and geometric assets</p>
                  </div>
                  <div className="text-right">
                    <span className="text-4xl font-serif text-indigo-500 font-bold">{allAssets.length}</span>
                    <p className="text-slate-500 font-mono text-[8px] uppercase tracking-tighter">Total Assets Indexed</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                  {allAssets.map((asset, idx) => (
                    <motion.div 
                      key={asset.id}
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: idx * 0.05 }}
                      className="group bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden hover:border-indigo-500/50 transition-all flex flex-col"
                    >
                      <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900/50">
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${asset.type === 'diagram' ? 'bg-indigo-500' : 'bg-pink-500'}`}></div>
                          <span className="text-[9px] font-mono font-bold text-slate-300 uppercase tracking-widest">{asset.type}</span>
                        </div>
                        <span className="text-[8px] font-mono text-slate-500">PG. {asset.pageNumber}</span>
                      </div>
                      
                      <div className="aspect-square bg-black p-4 flex items-center justify-center relative group">
                        {asset.metadata?.croppedUrl ? (
                          <img 
                            src={asset.metadata.croppedUrl} 
                            className="max-w-full max-h-full object-contain group-hover:scale-110 transition-transform duration-500" 
                            alt={asset.metadata?.label}
                          />
                        ) : (
                          <div className="text-slate-800"><Layers size={48} /></div>
                        )}
                        
                        <div className="absolute inset-0 bg-indigo-600/0 group-hover:bg-indigo-600/10 transition-all pointer-events-none"></div>

                        <button 
                          onClick={() => {
                            const pIndex = paper.pages.findIndex(p => p.pageNumber === asset.pageNumber);
                            setCurrentPageIndex(pIndex);
                            setViewMode('document');
                          }}
                          className="absolute bottom-3 right-3 opacity-0 group-hover:opacity-100 bg-indigo-600 text-white p-2.5 rounded-xl shadow-2xl translate-y-2 group-hover:translate-y-0 transition-all"
                        >
                          <ChevronRight size={14} />
                        </button>
                      </div>

                      <div className="p-4 bg-slate-900/80 flex-1 flex flex-col justify-between">
                        <p className="text-[10px] text-slate-300 font-medium leading-relaxed italic border-l-2 border-indigo-500/50 pl-3 mb-4">
                          {asset.metadata?.label || "Geometric illustration"}
                        </p>
                        <div className="flex gap-2">
                           <button className="flex-1 py-1.5 bg-slate-800 hover:bg-slate-700 text-[8px] font-bold text-slate-400 uppercase tracking-widest rounded border border-slate-700 transition-colors">
                              Focus
                           </button>
                           <button className="flex-1 py-1.5 bg-slate-800 hover:bg-slate-700 text-[8px] font-bold text-slate-400 uppercase tracking-widest rounded border border-slate-700 transition-colors">
                              Analyze
                           </button>
                        </div>
                      </div>
                    </motion.div>
                  ))}

                  {allAssets.length === 0 && (
                    <div className="col-span-full py-40 text-center bg-slate-900/30 border border-slate-800 rounded-3xl border-dashed">
                       <Layers size={48} className="mx-auto text-slate-700 mb-4 opacity-20" />
                       <p className="text-slate-500 font-mono text-[10px] uppercase tracking-[0.2em]">No geometric assets indexed in this paper</p>
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

          {viewMode === 'document' && (
            <aside className="w-96 border-l border-slate-800 bg-slate-900/30 flex flex-col overflow-hidden">
              <div className="p-6 border-b border-slate-800">
                <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold mb-1">Indexed Components</p>
                <h4 className="text-sm font-medium text-slate-100">Geometric & Technical Data</h4>
              </div>
              
              <div className="flex-1 overflow-y-auto p-6 space-y-8">
                {currentPage.layout.filter(el => el.type === 'diagram' || el.type === 'table' || el.type === 'equation' || el.solution).map((diag, idx) => (
                  <motion.div 
                    key={idx}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.1 }}
                    className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-4 group hover:border-indigo-500/30 transition-all font-mono"
                  >
                    <div className="flex justify-between items-start mb-3">
                      <div>
                        <h4 className="text-[10px] uppercase font-bold text-slate-200">{diag.type}</h4>
                        <p className="text-[9px] text-slate-500 mt-1 truncate max-w-[200px]">{diag.metadata?.label || diag.id}</p>
                      </div>
                      <div className={`px-2 py-0.5 rounded text-[8px] font-bold text-white uppercase ${diag.type === 'diagram' ? 'bg-indigo-600' : diag.solution ? 'bg-emerald-600' : 'bg-pink-600'}`}>
                        {diag.solution ? 'Solved' : diag.type === 'diagram' ? 'Asset' : 'Latex'}
                      </div>
                    </div>

                    {diag.metadata?.croppedUrl && (
                      <div className="aspect-[4/3] bg-slate-900 rounded overflow-hidden flex items-center justify-center p-2 border border-slate-700/50 mb-4">
                        <img src={diag.metadata.croppedUrl} className="max-w-full max-h-full object-contain" />
                      </div>
                    )}

                    <div className="pt-3 border-t border-slate-700/40">
                      <p className="text-[8px] text-slate-400 flex items-center gap-2">
                         <span className="text-slate-600">BOX:</span> 
                         [{diag.box_2d.join(', ')}]
                      </p>
                    </div>
                  </motion.div>
                ))}

                {currentPage.layout.length === 0 && (
                  <div className="py-20 text-center">
                    <div className="w-12 h-12 bg-slate-800 border border-slate-700 border-dashed rounded-full flex items-center justify-center mx-auto mb-4 opacity-40">
                        <Layers size={20} className="text-slate-500" />
                    </div>
                    <p className="text-[10px] font-mono text-slate-600 uppercase tracking-widest">No active assets on page</p>
                  </div>
                )}
              </div>
              
              <div className="p-4 border-t border-slate-800 bg-slate-900/50">
                <button className="w-full py-2.5 bg-slate-800 border border-slate-700 hover:bg-slate-700 rounded text-[10px] font-bold uppercase tracking-widest text-slate-300 transition-all">
                  Generate Technical Report
                </button>
              </div>
            </aside>
          )}
        </main>
      </div>
    </div>
  );
}
