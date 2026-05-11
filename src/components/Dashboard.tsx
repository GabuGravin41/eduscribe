import React, { useState } from 'react';
import { Paper } from '../types';
import { FileText, Calendar, ChevronRight, Download, Loader2, Zap, LayoutGrid, Image as ImageIcon, Search, Info, Table } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { downloadTabularCSV } from '../lib/utils';

interface DashboardProps {
  papers: Paper[];
  onSelectPaper: (paper: Paper) => void;
  onNewPaper: () => void;
}

export default function Dashboard({ papers, onSelectPaper, onNewPaper }: DashboardProps) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'date' | 'title'>('date');
  const [viewMode, setViewMode] = useState<'papers' | 'gallery'>('papers');

  // Aggregated assets for gallery mode
  const allAssets = papers.flatMap(paper => 
    paper.pages.flatMap(page => 
      page.layout
        .filter(el => (el.type === 'diagram' || el.type === 'table') && el.metadata?.croppedUrl)
        .map(el => ({ 
          ...el, 
          paperTitle: paper.title, 
          paperId: paper.id, 
          pageNumber: page.pageNumber,
          fullPaper: paper
        }))
    )
  );

  const filteredAssets = allAssets.filter(asset => 
    asset.paperTitle.toLowerCase().includes(search.toLowerCase()) || 
    asset.metadata?.label?.toLowerCase().includes(search.toLowerCase())
  );

  const filteredPapers = papers
    .filter(p => 
      p.title.toLowerCase().includes(search.toLowerCase()) || 
      p.metadata.unitCode?.toLowerCase().includes(search.toLowerCase()) ||
      p.metadata.institution?.toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => {
      if (sortBy === 'date') return new Date(b.date).getTime() - new Date(a.date).getTime();
      return a.title.localeCompare(b.title);
    });

  const downloadPack = async (e: React.MouseEvent, paper: Paper) => {
    e.stopPropagation();
    setDownloadingId(paper.id);
    try {
      const zip = new JSZip();
      const assetsFolder = zip.folder("assets");
      let markdownContent = `# ${paper.title}\n\n`;

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
          }
        }
      }
      zip.file("document.md", markdownContent);
      const content = await zip.generateAsync({ type: "blob" });
      saveAs(content, `${paper.title.replace(/\s+/g, '_')}_Bundle.zip`);
    } catch (err) {
      console.error(err);
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div className="h-full flex flex-col bg-slate-950">
      <div className="p-8 max-w-6xl w-full mx-auto flex-1 overflow-y-auto">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-12 gap-6">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Workspace Overview</p>
              <div className="w-1 h-1 rounded-full bg-indigo-500"></div>
              <p className="text-[10px] uppercase tracking-widest text-indigo-400 font-bold">{papers.length} Documents</p>
            </div>
            <h1 className="text-3xl font-serif text-slate-100 font-bold">
              Knowledge Repository
            </h1>
          </div>
          <div className="flex flex-wrap gap-4 w-full md:w-auto items-center">
            {/* View Mode Toggle */}
            <div className="flex bg-slate-900 border border-slate-800 rounded p-1 mr-2">
              <button 
                onClick={() => setViewMode('papers')}
                className={`p-1.5 rounded transition-all ${viewMode === 'papers' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
                title="Paper Cards"
              >
                <LayoutGrid size={16} />
              </button>
              <button 
                onClick={() => setViewMode('gallery')}
                className={`p-1.5 rounded transition-all ${viewMode === 'gallery' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
                title="Global Gallery"
              >
                <ImageIcon size={16} />
              </button>
            </div>

            <div className="relative flex-1 md:w-64">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
              <input 
                type="text" 
                placeholder={viewMode === 'gallery' ? "Search assets..." : "Search repository..."}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full bg-slate-900 border border-slate-800 rounded pl-10 pr-4 py-2.5 text-xs text-slate-100 focus:border-indigo-500 outline-none transition-all placeholder:text-slate-700"
              />
            </div>
            {viewMode === 'papers' && (
              <button 
                onClick={() => setSortBy(prev => prev === 'date' ? 'title' : 'date')}
                className="px-4 py-2.5 bg-slate-900 border border-slate-800 text-slate-400 text-[10px] uppercase font-bold tracking-widest hover:text-indigo-400 transition-all rounded font-mono"
              >
                Sort: {sortBy}
              </button>
            )}
            <button 
              onClick={() => downloadTabularCSV(papers)}
              className="group relative px-6 py-2.5 bg-slate-900 border border-slate-800 text-slate-300 text-xs font-bold uppercase tracking-widest rounded hover:bg-slate-800 transition-all flex items-center gap-2"
            >
              <Table size={14} className="group-hover:text-amber-400 transition-colors" />
              Dataset Export (CSV)
            </button>
            <button 
              onClick={onNewPaper}
              className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold uppercase tracking-widest rounded transition-all shadow-lg shadow-indigo-600/20 whitespace-nowrap"
            >
              New Batch
            </button>
          </div>
        </div>

        <AnimatePresence mode="wait">
          {viewMode === 'papers' ? (
            <motion.div 
              key="papers-grid"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
            >
              {filteredPapers.length === 0 ? (
                <div className="col-span-full py-32 text-center border border-slate-800 bg-slate-900/20 rounded-xl">
                  <FileText size={48} className="mx-auto text-slate-700 mb-4" />
                  <p className="text-slate-500 font-mono text-sm uppercase tracking-widest">{search ? 'No matches found' : 'No documents in pipeline'}.</p>
                </div>
              ) : (
                filteredPapers.map((paper) => {
                  const hasSolutions = paper.pages.some(p => p.layout.some(el => !!el.solution));
                  const assetCount = paper.pages.reduce((acc, p) => acc + p.layout.filter(el => el.type === 'diagram' || el.type === 'table').length, 0);
                  return (
                    <motion.div 
                      key={paper.id}
                      onClick={() => onSelectPaper(paper)}
                      className="p-5 bg-slate-900/50 border border-slate-800 rounded-xl hover:border-indigo-500/50 hover:bg-slate-900 transition-all cursor-pointer group flex flex-col gap-4 relative"
                    >
                      {hasSolutions && (
                        <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full z-10">
                          <Zap size={8} className="text-emerald-500 fill-emerald-500" />
                          <span className="text-[7px] text-emerald-500 font-bold uppercase tracking-tighter">Solved</span>
                        </div>
                      )}
                      <div className="flex justify-between items-start">
                        <div className="w-10 h-12 bg-slate-800 rounded border border-slate-700 flex items-center justify-center">
                          <FileText size={20} className="text-slate-500 group-hover:text-indigo-400 transition-colors" />
                        </div>
                        <div className="flex gap-2">
                          <button 
                            onClick={(e) => downloadPack(e, paper)}
                            className="p-1.5 bg-slate-800 rounded-full text-slate-500 hover:text-indigo-400 hover:bg-slate-700 transition-all"
                          >
                            {downloadingId === paper.id ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                          </button>
                          <div className="bg-emerald-500/10 text-emerald-500 text-[9px] font-bold uppercase py-0.5 px-2 rounded-full border border-emerald-500/20">
                            Safe
                          </div>
                        </div>
                      </div>
                      
                      <div>
                        <div className="flex flex-wrap gap-1 mb-2">
                          {paper.metadata.institution && (
                            <span className="text-[7px] bg-indigo-500/10 text-indigo-400 px-1.5 py-0.5 rounded uppercase border border-indigo-500/20">{paper.metadata.institution}</span>
                          )}
                          {paper.metadata.unitCode && (
                            <span className="text-[7px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded border border-slate-700">{paper.metadata.unitCode}</span>
                          )}
                          {paper.metadata.assessmentType && (
                            <span className="text-[7px] bg-pink-500/10 text-pink-500 px-1.5 py-0.5 rounded border border-pink-500/20">{paper.metadata.assessmentType}</span>
                          )}
                        </div>
                        <h3 className="text-slate-100 font-medium text-sm line-clamp-2 mb-1 h-10">{paper.title}</h3>
                        <div className="flex items-center gap-2 text-[10px] text-slate-500 font-mono uppercase">
                          <Calendar size={12} />
                          {paper.metadata.administeredDate || new Date(paper.date).toLocaleDateString()}
                        </div>
                      </div>

                      <div className="pt-4 border-t border-slate-800/50 flex justify-between items-center">
                        <span className="text-[10px] font-mono text-slate-500 group-hover:text-slate-300">
                          {assetCount} ASSETS
                        </span>
                        <ChevronRight size={14} className="text-slate-600 group-hover:text-indigo-500 group-hover:translate-x-1 transition-all" />
                      </div>
                    </motion.div>
                  );
                })
              )}
            </motion.div>
          ) : (
            <motion.div 
              key="gallery-grid"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4"
            >
              {filteredAssets.length === 0 ? (
                <div className="col-span-full py-40 text-center bg-slate-900/20 border border-slate-800 rounded-2xl border-dashed">
                  <ImageIcon size={48} className="mx-auto text-slate-700 mb-4 opacity-20" />
                  <p className="text-slate-500 font-mono text-xs uppercase tracking-widest">No visual assets discovered yet</p>
                </div>
              ) : (
                filteredAssets.map((asset, idx) => (
                  <motion.div 
                    key={`${asset.paperId}-${asset.id}`}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.02 }}
                    onClick={() => onSelectPaper(asset.fullPaper)}
                    className="group aspect-square bg-slate-900 border border-slate-800 rounded-lg overflow-hidden cursor-pointer hover:border-indigo-500/50 transition-all relative"
                  >
                    <img 
                      src={asset.metadata?.croppedUrl} 
                      className="w-full h-full object-contain p-2 group-hover:scale-110 transition-transform duration-500" 
                      alt={asset.metadata?.label}
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity p-3 flex flex-col justify-end">
                      <p className="text-[8px] font-mono text-indigo-400 font-bold uppercase mb-1 truncate">{asset.paperTitle}</p>
                      <p className="text-[9px] text-white font-medium line-clamp-1">{asset.metadata?.label || 'Diagram Asset'}</p>
                    </div>
                  </motion.div>
                ))
              )}
            </motion.div>
          )}
        </AnimatePresence>

      </div>
    </div>
  );
}
