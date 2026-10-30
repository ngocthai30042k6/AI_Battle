import React, { useLayoutEffect, useRef, useState } from 'react';

export function SingleLineName({ children, maxSize = 12, minSize = 8, className = '' }: {
  children:string; maxSize?:number; minSize?:number; className?:string;
}) {
  const container = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState(maxSize);
  useLayoutEffect(() => {
    let disposed = false;
    const fit = () => {
      if (disposed || !container.current?.clientWidth || !text.current) return;
      text.current.style.fontSize = `${maxSize}px`;
      const naturalWidth = text.current.scrollWidth;
      const next = Math.max(minSize, Math.min(maxSize, Math.floor(maxSize * container.current.clientWidth / Math.max(1,naturalWidth) * 10) / 10));
      text.current.style.fontSize = `${next}px`;
      setSize(next);
    };
    const observer = new ResizeObserver(fit);
    if (container.current) observer.observe(container.current);
    void document.fonts.ready.then(fit);
    fit();
    return () => { disposed = true; observer.disconnect(); };
  }, [children,maxSize,minSize]);
  return <span ref={container} title={children} data-single-line-name className={`block w-full min-w-0 overflow-hidden whitespace-nowrap ${className}`}>
    <span ref={text} className="inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap align-middle" style={{fontSize:size}}>{children}</span>
  </span>;
}
