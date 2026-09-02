import React from 'react';
import Markdown from 'react-markdown';

interface RenderedMarkdownProps {
  content: string;
  className?: string;
  variant?: 'light' | 'glass';
}

export const RenderedMarkdown: React.FC<RenderedMarkdownProps> = ({ content, className = '', variant = 'light' }) => {
  if (!content || !content.trim()) return null;

  const isGlass = variant === 'glass';

  return (
    <div className={`rendered-markdown leading-relaxed text-sm ${isGlass ? 'text-white' : 'text-slate-800'} ${className}`}>
      <Markdown
        components={{
          h1: ({ children }) => (
            <h1 className={`text-base sm:text-lg font-bold mt-2 mb-2.5 pb-1.5 border-b flex items-center gap-2 ${isGlass ? 'text-white border-white/20' : 'text-slate-900 border-slate-200/80'}`}>
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className={`text-sm sm:text-base font-bold mt-3 mb-1.5 flex items-center gap-1.5 ${isGlass ? 'text-white' : 'text-slate-900'}`}>
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className={`text-xs sm:text-sm font-bold uppercase tracking-wider mt-3 mb-1 ${isGlass ? 'text-white/90' : 'text-indigo-900'}`}>
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p className={`mb-2 leading-relaxed last:mb-0 ${isGlass ? 'text-white/90' : 'text-slate-700'}`}>
              {children}
            </p>
          ),
          blockquote: ({ children }) => (
            <blockquote className={`my-2.5 border-l-3 px-3.5 py-2 rounded-r-xl text-xs sm:text-sm font-medium shadow-xs ${isGlass ? 'bg-white/10 border-white/40 text-white' : 'bg-indigo-50/80 border-indigo-500 text-indigo-950'}`}>
              {children}
            </blockquote>
          ),
          ul: ({ children }) => (
            <ul className={`list-disc pl-5 space-y-1 my-2 ${isGlass ? 'text-white/90' : 'text-slate-700'}`}>
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className={`list-decimal pl-5 space-y-1 my-2 ${isGlass ? 'text-white/90' : 'text-slate-700'}`}>
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="leading-snug">{children}</li>
          ),
          table: ({ children }) => (
            <div className={`overflow-x-auto my-3 rounded-xl border shadow-2xs ${isGlass ? 'border-white/20' : 'border-slate-200/90'}`}>
              <table className={`w-full text-xs text-left border-collapse ${isGlass ? 'bg-white/10 text-white' : 'bg-white'}`}>
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className={`font-semibold border-b ${isGlass ? 'bg-white/15 text-white border-white/20' : 'bg-slate-50 text-slate-700 border-slate-200'}`}>
              {children}
            </thead>
          ),
          th: ({ children }) => (
            <th className={`px-3 py-2 font-bold uppercase text-[11px] tracking-wider ${isGlass ? 'text-white' : 'text-slate-800'}`}>
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className={`px-3 py-2 border-b ${isGlass ? 'border-white/10 text-white/90' : 'border-slate-100 text-slate-700'}`}>
              {children}
            </td>
          ),
          code: ({ children }) => (
            <code className={`font-mono text-[11px] px-1.5 py-0.5 rounded-md border ${isGlass ? 'bg-white/20 text-white border-white/30' : 'bg-slate-100 text-indigo-700 border-slate-200'}`}>
              {children}
            </code>
          ),
          strong: ({ children }) => (
            <strong className={`font-bold ${isGlass ? 'text-white' : 'text-slate-900'}`}>{children}</strong>
          ),
          hr: () => (
            <hr className={`my-3 border-t ${isGlass ? 'border-white/20' : 'border-slate-200/80'}`} />
          )
        }}
      >
        {content}
      </Markdown>
    </div>
  );
};
