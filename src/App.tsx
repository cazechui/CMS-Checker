import { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import { UploadCloud, FileText, AlertCircle, CheckCircle2, Loader2, X, ArrowRightLeft } from 'lucide-react';
import { cn } from './lib/utils';

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result.split(',')[1]);
      } else {
        reject(new Error('Failed to convert file to base64'));
      }
    };
    reader.onerror = error => reject(error);
  });
};

const playSuccessSound = () => {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();

    const playNote = (freq: number, startTime: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(0.2, startTime + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
      
      osc.start(startTime);
      osc.stop(startTime + duration);
    };

    const now = ctx.currentTime;
    playNote(523.25, now, 0.15); // C5
    playNote(659.25, now + 0.15, 0.15); // E5
    playNote(783.99, now + 0.3, 0.4); // G5
  } catch (e) {
    console.error("Audio playback failed", e);
  }
};

type AnalysisResult = {
  sourceTextHighlighted: string;
  cmsTextHighlighted: string;
  discrepancies: Array<{
    description: string;
  }>;
};

export default function App() {
  const [sourceFiles, setSourceFiles] = useState<File[]>([]);
  const [sourceText, setSourceText] = useState('');
  const [cmsDraftText, setCmsDraftText] = useState('');
  const [cmsDraftFiles, setCmsDraftFiles] = useState<File[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState('gemini-3-flash-preview');

  const sourceFileInputRef = useRef<HTMLInputElement>(null);
  const cmsFileInputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const handleSourceFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setSourceFiles(prev => [...prev, ...Array.from(e.target.files!)]);
    }
    e.target.value = '';
  };

  const handleCmsFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setCmsDraftFiles(prev => [...prev, ...Array.from(e.target.files!)]);
    }
    e.target.value = '';
  };

  const removeSourceFile = (index: number) => {
    setSourceFiles(prev => prev.filter((_, i) => i !== index));
  };

  const removeCmsFile = (index: number) => {
    setCmsDraftFiles(prev => prev.filter((_, i) => i !== index));
  };

  const analyzeContent = async () => {
    if (!sourceText.trim() && sourceFiles.length === 0) {
      setError('Please provide the source documents (text or file).');
      return;
    }
    if (!cmsDraftText.trim() && cmsDraftFiles.length === 0) {
      setError('Please provide the CMS draft (text or file).');
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'undefined' || apiKey === 'null') {
      setError('GEMINI_API_KEY is missing. Please add it to your Vercel Environment Variables and redeploy.');
      return;
    }

    setIsAnalyzing(true);
    setError(null);
    setAnalysisResult(null);

    try {
      const ai = new GoogleGenAI({ apiKey });
      const parts: any[] = [];

      // Add source files
      parts.push({ text: '--- SOURCE DOCUMENTS ---' });
      if (sourceText.trim()) {
        parts.push({ text: sourceText });
      }
      for (const file of sourceFiles) {
        const base64Data = await fileToBase64(file);
        parts.push({
          inlineData: {
            mimeType: file.type || 'application/octet-stream',
            data: base64Data,
          }
        });
        parts.push({ text: `(End of source document: ${file.name})` });
      }

      // Add CMS draft
      parts.push({ text: '\n--- CMS DRAFT ---' });
      if (cmsDraftText.trim()) {
        parts.push({ text: cmsDraftText });
      }
      for (const file of cmsDraftFiles) {
        const base64Data = await fileToBase64(file);
        parts.push({
          inlineData: {
            mimeType: file.type || 'application/octet-stream',
            data: base64Data,
          }
        });
      }

      const prompt = `You are an expert content reviewer and QA specialist.
Cross-check the provided CMS Draft against the Source Documents and identify human errors, inconsistencies, or omissions.

Look for:
1. Duplications (repeated content).
2. Wrong titles, headings, or names.
3. Missing information (important details from the source left out).
4. Factual inconsistencies (numbers, dates, facts that don't match).

DO NOT check for formatting or structural issues.

Return the full text of the source documents and the full text of the CMS draft.
For any text that contains a discrepancy (the wrong text or missing context), wrap it EXACTLY in <mark> tags.
Use plain text with \\n for line breaks, do not use markdown.`;

      parts.push({ text: prompt });

      const response = await ai.models.generateContent({
        model: selectedModel,
        contents: { parts },
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              sourceTextHighlighted: {
                type: Type.STRING,
                description: "Full text of the source documents. Wrap discrepancies in <mark> tags."
              },
              cmsTextHighlighted: {
                type: Type.STRING,
                description: "Full text of the CMS draft. Wrap discrepancies in <mark> tags."
              },
              discrepancies: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    description: { type: Type.STRING }
                  }
                }
              }
            }
          }
        }
      });

      const resultText = response.text;
      if (resultText) {
        // Strip potential markdown code blocks that the AI sometimes includes
        const cleanText = resultText.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
        setAnalysisResult(JSON.parse(cleanText));
        playSuccessSound();
        setTimeout(() => {
          resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
      } else {
        setError('No response generated.');
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An error occurred during analysis.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f5f5f5] text-slate-900 font-sans flex flex-col">
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <CheckCircle2 className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">CMS Cross-Checker</h1>
        </div>
      </header>

      <main className="flex-1 p-6 flex flex-col gap-8 max-w-[1600px] mx-auto w-full">
        
        {/* Upload Section */}
        <div className="flex flex-col lg:flex-row gap-6 items-stretch relative">
          
          {/* Left Column: Source Documents */}
          <div className="flex-1 flex flex-col gap-4">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 flex-1 flex flex-col min-h-[400px]">
              <h2 className="text-lg font-semibold mb-1 flex items-center gap-2">
                <FileText className="w-5 h-5 text-slate-500" />
                Source Documents
              </h2>
              <p className="text-sm text-slate-500 mb-6">Paste the original content or upload reference files.</p>
              
              <textarea
                value={sourceText}
                onChange={(e) => setSourceText(e.target.value)}
                placeholder="Paste your source document content here..."
                className="w-full flex-1 min-h-[160px] p-4 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all resize-none text-sm font-mono"
              />

              <div className="mt-4 flex items-center gap-4">
                <div className="h-px bg-slate-200 flex-1"></div>
                <span className="text-xs text-slate-400 font-medium uppercase tracking-wider">OR</span>
                <div className="h-px bg-slate-200 flex-1"></div>
              </div>

              <div className="mt-4">
                <button 
                  onClick={() => sourceFileInputRef.current?.click()}
                  className="w-full py-3 border border-slate-200 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors flex items-center justify-center gap-2"
                >
                  <UploadCloud className="w-4 h-4" />
                  Upload Source File
                </button>
                <input 
                  type="file" 
                  multiple 
                  className="hidden" 
                  ref={sourceFileInputRef}
                  onChange={handleSourceFileChange}
                  accept=".pdf,.txt,.md,.csv"
                />
              </div>

              {sourceFiles.length > 0 && (
                <div className="flex flex-col gap-2 overflow-y-auto flex-1">
                  {sourceFiles.map((file, idx) => (
                    <div key={idx} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-100">
                      <div className="flex items-center gap-3 overflow-hidden">
                        <FileText className="w-4 h-4 text-blue-500 flex-shrink-0" />
                        <span className="text-sm font-medium truncate">{file.name}</span>
                      </div>
                      <button onClick={() => removeSourceFile(idx)} className="text-slate-400 hover:text-red-500 p-1">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Center Action Button & Options */}
          <div className="flex flex-col items-center justify-center lg:px-4 py-4 lg:py-0 gap-6">
            <button
              onClick={analyzeContent}
              disabled={isAnalyzing}
              className={cn(
                "w-32 h-32 rounded-full flex flex-col items-center justify-center gap-2 text-white font-semibold transition-all duration-300 shadow-xl z-10",
                isAnalyzing 
                  ? "bg-slate-400 cursor-not-allowed scale-95" 
                  : "bg-blue-600 hover:bg-blue-700 hover:scale-105 hover:shadow-2xl active:scale-95 cursor-pointer"
              )}
            >
              {isAnalyzing ? (
                <>
                  <Loader2 className="w-8 h-8 animate-spin" />
                  <span className="text-sm">Analyzing...</span>
                </>
              ) : (
                <>
                  <ArrowRightLeft className="w-8 h-8" />
                  <span className="text-sm text-center leading-tight">Run<br/>Comparison</span>
                </>
              )}
            </button>

            <div className="flex flex-col items-center gap-2">
              <label htmlFor="model-select" className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                AI Model
              </label>
              <select 
                id="model-select"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={isAnalyzing}
                className="text-sm bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <option value="gemini-3-flash-preview">Flash (Fastest)</option>
                <option value="gemini-3.1-pro-preview">Pro (Most Accurate)</option>
              </select>
            </div>
          </div>

          {/* Right Column: CMS Draft */}
          <div className="flex-1 flex flex-col gap-4">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 flex-1 flex flex-col min-h-[400px]">
              <h2 className="text-lg font-semibold mb-1 flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-slate-500" />
                CMS Draft
              </h2>
              <p className="text-sm text-slate-500 mb-6">Paste the drafted content or upload the draft file.</p>
              
              <textarea
                value={cmsDraftText}
                onChange={(e) => setCmsDraftText(e.target.value)}
                placeholder="Paste your CMS draft content here..."
                className="w-full flex-1 min-h-[160px] p-4 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all resize-none text-sm font-mono"
              />

              <div className="mt-4 flex items-center gap-4">
                <div className="h-px bg-slate-200 flex-1"></div>
                <span className="text-xs text-slate-400 font-medium uppercase tracking-wider">OR</span>
                <div className="h-px bg-slate-200 flex-1"></div>
              </div>

              <div className="mt-4">
                <button 
                  onClick={() => cmsFileInputRef.current?.click()}
                  className="w-full py-3 border border-slate-200 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors flex items-center justify-center gap-2"
                >
                  <UploadCloud className="w-4 h-4" />
                  Upload Draft File
                </button>
                <input 
                  type="file" 
                  multiple 
                  className="hidden" 
                  ref={cmsFileInputRef}
                  onChange={handleCmsFileChange}
                  accept=".pdf,.txt,.md,.csv"
                />
              </div>

              {cmsDraftFiles.length > 0 && (
                <div className="flex flex-col gap-2 mt-4">
                  {cmsDraftFiles.map((file, idx) => (
                    <div key={idx} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-100">
                      <div className="flex items-center gap-3 overflow-hidden">
                        <FileText className="w-4 h-4 text-orange-500 flex-shrink-0" />
                        <span className="text-sm font-medium truncate">{file.name}</span>
                      </div>
                      <button onClick={() => removeCmsFile(idx)} className="text-slate-400 hover:text-red-500 p-1">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Error Panel */}
        {error && (
          <div className="bg-white rounded-2xl shadow-sm border border-red-200 p-6">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xl font-semibold flex items-center gap-2 text-red-600">
                <AlertCircle className="w-6 h-6" /> Error
              </h2>
              <button 
                onClick={() => setError(null)}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="p-4 bg-red-50 text-red-700 rounded-xl border border-red-100">
              {error}
            </div>
          </div>
        )}

        {/* Results Section */}
        {analysisResult && (
          <div ref={resultsRef} className="flex flex-col gap-6 pt-8 border-t border-slate-200 animate-in fade-in slide-in-from-bottom-8 duration-500">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold flex items-center gap-2">
                <CheckCircle2 className="w-7 h-7 text-green-500" />
                Comparison Results
              </h2>
              <button 
                onClick={() => setAnalysisResult(null)}
                className="text-slate-500 hover:text-slate-800 flex items-center gap-1 text-sm font-medium"
              >
                <X className="w-4 h-4" /> Clear Results
              </button>
            </div>

            {/* Discrepancies summary */}
            {analysisResult.discrepancies && analysisResult.discrepancies.length > 0 && (
              <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
                <h3 className="font-semibold mb-3 flex items-center gap-2 text-slate-800">
                  <AlertCircle className="w-5 h-5 text-red-500" />
                  Identified Issues ({analysisResult.discrepancies.length})
                </h3>
                <ul className="list-disc pl-6 space-y-2 text-slate-600">
                  {analysisResult.discrepancies.map((d, i) => (
                    <li key={i}>{d.description}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-col lg:flex-row gap-6">
              {/* Left Column: Source Document */}
              <div className="flex-1 bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col overflow-hidden">
                <div className="p-4 border-b border-slate-200 bg-slate-50">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <FileText className="w-5 h-5 text-blue-500" />
                    Source Document
                  </h3>
                </div>
                <div className="p-6 flex-1">
                  <div
                    className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-slate-700"
                    dangerouslySetInnerHTML={{ __html: analysisResult.sourceTextHighlighted }}
                  />
                </div>
              </div>

              {/* Right Column: CMS Draft */}
              <div className="flex-1 bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col overflow-hidden">
                <div className="p-4 border-b border-slate-200 bg-slate-50">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <AlertCircle className="w-5 h-5 text-orange-500" />
                    CMS Draft
                  </h3>
                </div>
                <div className="p-6 flex-1">
                  <div
                    className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-slate-700"
                    dangerouslySetInnerHTML={{ __html: analysisResult.cmsTextHighlighted }}
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
