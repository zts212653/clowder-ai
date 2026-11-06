export function useSendMessage() {
  return {
    handleSend: async () => {
      throw new Error('This navigation probe never sends messages');
    },
    uploadStatus: 'idle',
    uploadError: null,
  };
}

export function RecentWorks() {
  return null;
}
export function SessionImportPanel() {
  return null;
}
export function DemoEntryActions() {
  return null;
}
export function useRouter() {
  return { push() {}, replace() {}, prefetch() {} };
}
export function usePathname() {
  return '/';
}
export function useSearchParams() {
  return new URLSearchParams();
}
export default function Image({ src, alt }: { src: string; alt: string }) {
  // biome-ignore lint/performance/noImgElement: This fixture replaces the Next image wrapper in an isolated browser bundle.
  return <img src={src} alt={alt} />;
}
