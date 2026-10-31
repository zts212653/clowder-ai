interface MockFont {
  className: string;
  style: {
    fontFamily: string;
  };
  variable: string;
}

function createMockFont(name: string): MockFont {
  return {
    className: `mock-font-${name}`,
    style: { fontFamily: `${name}, sans-serif` },
    variable: '',
  };
}

export function Fraunces(): MockFont {
  return createMockFont('Fraunces');
}

export function Plus_Jakarta_Sans(): MockFont {
  return createMockFont('PlusJakartaSans');
}

export function Press_Start_2P(): MockFont {
  return createMockFont('PressStart2P');
}

export function Silkscreen(): MockFont {
  return createMockFont('Silkscreen');
}
