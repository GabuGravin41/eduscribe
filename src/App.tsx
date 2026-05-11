/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import Dashboard from './components/Dashboard';
import Uploader from './components/Uploader';
import PaperDetail from './components/PaperDetail';
import { Paper } from './types';
import { Database, Zap, BookOpen, Layers, Terminal } from 'lucide-react';

import { getAllPapersFromDb } from './lib/db';

export default function App() {
  const [view, setView] = useState<'dashboard' | 'uploader' | 'detail'>('dashboard');
  const [papers, setPapers] = useState<Paper[]>([]);
  const [selectedPaper, setSelectedPaper] = useState<Paper | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchPapers();
  }, []);

  const fetchPapers = async () => {
    setLoading(true);
    try {
      const data = await getAllPapersFromDb();
      if (data && Array.isArray(data)) {
        setPapers(data);
      }
    } catch (e) {
      console.error("Failed to fetch papers from DB", e);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectPaper = (paper: Paper) => {
    setSelectedPaper(paper);
    setView('detail');
  };

  const handleUploadComplete = (paper: Paper) => {
    fetchPapers();
    setView('dashboard');
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 font-sans">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-slate-800 bg-slate-900/50 fixed top-0 left-0 right-0 z-50 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-600 rounded flex items-center justify-center">
            <Database size={18} className="text-white" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-100">
            EduScribe <span className="text-slate-500 font-normal ml-2">/ Engineering Pipeline</span>
          </h1>
        </div>
        <div className="flex gap-4">
          <div className="flex items-center gap-2 px-3 py-1 bg-slate-800 rounded-full border border-slate-700">
            <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]"></span>
            <span className="text-[10px] uppercase font-bold tracking-wider text-slate-300">System Ready</span>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="pt-14 h-screen flex flex-col">
        {loading && view === 'dashboard' ? (
          <div className="flex-1 flex flex-col items-center justify-center">
             <div className="animate-pulse flex flex-col items-center gap-4">
               <div className="w-12 h-12 bg-slate-800 rounded-full border-t-2 border-indigo-500 animate-spin"></div>
               <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Initializing Repository...</span>
             </div>
          </div>
        ) : (
          <div className="flex-1 overflow-hidden">
            {view === 'dashboard' && (
              <Dashboard 
                papers={papers} 
                onSelectPaper={handleSelectPaper} 
                onNewPaper={() => setView('uploader')}
              />
            )}

            {view === 'uploader' && (
              <Uploader 
                onComplete={handleUploadComplete} 
                onCancel={() => setView('dashboard')}
              />
            )}

            {view === 'detail' && selectedPaper && (
              <PaperDetail 
                paper={selectedPaper} 
                onBack={() => setView('dashboard')}
                onUpdate={(updated) => {
                  setPapers(prev => prev.map(p => p.id === updated.id ? updated : p));
                  setSelectedPaper(updated);
                }}
              />
            )}
          </div>
        )}
      </main>

      {/* Decorative Branding */}
      <div className="fixed bottom-4 right-8 pointer-events-none opacity-20 z-0">
        <span className="font-mono text-[8px] uppercase tracking-[0.4em] transform rotate-90 origin-bottom-right inline-block text-slate-500">
          STRUCTURIZE.AI // ENGINE_V1_STABLE
        </span>
      </div>
    </div>
  );
}

