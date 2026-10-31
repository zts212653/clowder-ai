interface MockFont {
  className: string;
  style: {
    fontFamily: string;
  };
  variable: string;
}

export default function localFont(_opts: {
  src: string | { path: string; weight: string }[];
  weight?: string;
  display?: string;
}): MockFont {
  const name = typeof _opts.src === 'string' ? _opts.src.replace(/.*\//, '').replace(/\.woff2$/, '') : 'local-font';
  return {
    className: `mock-font-${name}`,
    style: { fontFamily: `${name}, sans-serif` },
    variable: '',
  };
}
