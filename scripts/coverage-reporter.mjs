export default async function* coverageBadge(events) {
  for await (const event of events) {
    if (event.type !== 'test:coverage') continue;
    const { files, totals } = event.data.summary;
    if (!files.length) throw new Error('No extension source files found in coverage report');
    const percent = totals.coveredLinePercent;
    const value = `${percent.toFixed(2)}%`;
    const color = percent >= 90 ? '#4c1' : percent >= 80 ? '#97ca00' : percent >= 70 ? '#dfb317' : '#e05d44';
    yield `<svg xmlns="http://www.w3.org/2000/svg" width="130" height="20" role="img" aria-label="Extension line coverage: ${value}">
  <title>Extension line coverage: ${value}</title>
  <rect width="130" height="20" rx="3" fill="#555"/>
  <path fill="${color}" d="M65 0h62a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H65z"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="32.5" y="14">coverage</text>
    <text x="97.5" y="14">${value}</text>
  </g>
</svg>
`;
  }
}
