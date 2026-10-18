import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Chart } from '@ant-design/charts';

/** G2 5 listens to window resize only. Observe panel changes without remounting its canvas. */
export function useChartFrame() {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const [showLabels, setShowLabels] = useState(false);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const onReady = useCallback((chart: Chart) => {
    chartRef.current = chart;
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    let previousWidth = -1;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      if (width === previousWidth) return;
      previousWidth = width;
      // Only crossing this breakpoint changes React options; all resizing uses native G2.
      setShowLabels(width >= 600);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (width > 0 && element.querySelector('canvas'))
          chartRef.current?.chart.forceFit();
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    // Preserve the native tooltip and its content. This bridge only prevents viewport clipping.
    const layer = document.createElement('div');
    layer.className = 'transit-tooltip-layer';
    document.body.appendChild(layer);
    setHost(layer);
    let frame = 0;
    const clamp = () => {
      frame = 0;
      layer.querySelectorAll<HTMLElement>('.g2-tooltip').forEach((tip) => {
        if (getComputedStyle(tip).visibility === 'hidden') return;
        const box = tip.getBoundingClientRect();
        const left = Math.max(
          12,
          Math.min(box.left, window.innerWidth - box.width - 12),
        );
        const top = Math.max(
          12,
          Math.min(box.top, window.innerHeight - box.height - 12),
        );
        if (Math.abs(left - box.left) > 0.5)
          tip.style.left = `${(parseFloat(tip.style.left) || 0) + left - box.left}px`;
        if (Math.abs(top - box.top) > 0.5)
          tip.style.top = `${(parseFloat(tip.style.top) || 0) + top - box.top}px`;
      });
    };
    const changes = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(clamp);
    });
    changes.observe(layer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
    });
    const hide = () =>
      layer.querySelectorAll<HTMLElement>('.g2-tooltip').forEach((tip) => {
        tip.style.visibility = 'hidden';
      });
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      changes.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      layer.remove();
    };
  }, []);

  const tooltip = useMemo(
    () => ({ mount: host ?? undefined, offset: [14, 14] }),
    [host],
  );
  return { ref, showLabels, tooltip, ready: !!host, onReady };
}
