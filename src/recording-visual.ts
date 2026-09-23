export const VIDEO_WIDTH = 1280;
export const VIDEO_HEIGHT = 720;
export const BAR_HEIGHT = 40;
export const PAGE_WIDTH = 1506;
export const PAGE_HEIGHT = 800;

export function composeFrameExpression(jpeg: string, url: string, newTabUrl: string | null): string {
  return `(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(jpeg)}), character => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const canvas = document.createElement('canvas');
    canvas.width = ${VIDEO_WIDTH}; canvas.height = ${VIDEO_HEIGHT};
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create recording canvas');
    context.fillStyle = '#f5f7fa';
    context.fillRect(0, 0, canvas.width, ${BAR_HEIGHT});
    context.fillStyle = '#ffffff';
    context.beginPath();
    context.roundRect(12, 6, canvas.width - 24, 28, 7);
    context.fill();
    context.strokeStyle = '#d7dce4';
    context.lineWidth = 1;
    context.stroke();
    context.fillStyle = '#617185';
    context.beginPath(); context.arc(28, 20, 4, 0, Math.PI * 2); context.fill();
    const fit = (value, maxWidth) => {
      if (context.measureText(value).width <= maxWidth) return value;
      while (value.length && context.measureText(value + '…').width > maxWidth) value = value.slice(0, -1);
      return value + '…';
    };
    const url = ${JSON.stringify(url)};
    context.font = '14px system-ui, sans-serif';
    context.fillStyle = '#263343';
    context.textBaseline = 'middle';
    context.fillText(fit(url, canvas.width - 72), 42, 20);
    const chromeBorder = '#61738a';
    context.fillStyle = chromeBorder;
    context.fillRect(0, ${BAR_HEIGHT - 2}, canvas.width, 2);
    context.drawImage(bitmap, 0, ${BAR_HEIGHT}, canvas.width, canvas.height - ${BAR_HEIGHT});
    bitmap.close();
    const newTabUrl = ${JSON.stringify(newTabUrl)};
    if (newTabUrl) {
      const cardWidth = 620, cardHeight = 104, radius = 12, x = (canvas.width - cardWidth) / 2;
      const cardPath = () => {
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x + cardWidth, 0);
        context.lineTo(x + cardWidth, cardHeight - radius);
        context.quadraticCurveTo(x + cardWidth, cardHeight, x + cardWidth - radius, cardHeight);
        context.lineTo(x + radius, cardHeight);
        context.quadraticCurveTo(x, cardHeight, x, cardHeight - radius);
        context.closePath();
      };
      context.save();
      context.shadowColor = 'rgba(15, 23, 42, .24)';
      context.shadowBlur = 14;
      context.shadowOffsetY = 5;
      context.fillStyle = '#ffffff';
      cardPath(); context.fill();
      context.restore();
      context.strokeStyle = chromeBorder;
      context.lineWidth = 1.5;
      cardPath(); context.stroke();
      context.fillStyle = '#2563eb';
      context.beginPath(); context.arc(x + 28, 35, 7, 0, Math.PI * 2); context.fill();
      context.fillStyle = '#172033';
      context.font = '600 19px system-ui, sans-serif';
      context.fillText('New tab opened', x + 48, 35);
      context.fillStyle = '#536277';
      context.font = '14px system-ui, sans-serif';
      context.fillText(fit(newTabUrl, cardWidth - 52), x + 24, 72);
    }
    return canvas.toDataURL('image/jpeg', .88).split(',')[1];
  })()`;
}
