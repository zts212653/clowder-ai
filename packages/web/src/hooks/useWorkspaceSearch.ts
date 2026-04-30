import React, { useCallback, useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';

export function useWorkspaceSearch(deps: {
  search: (query: string, mode: 'content' | 'filename' | 'all') => Promise<void>;
  setSearchResults: (results: never[]) => void;
  setOpenFile: (path: string, line?: number) => void;
  revealInTree: (path: string) => void;
  onFileSelect: () => void;
}) {
  const { search, setSearchResults, setOpenFile, revealInTree, onFileSelect } = deps;

  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'content' | 'filename' | 'all'>('all');
  const [didSearch, setDidSearch] = useState(false);
  const searchIme = useIMEGuard();

  const handleSearchSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedQuery = searchQuery.trim();
      if (!trimmedQuery) {
        setDidSearch(false);
        setSearchResults([]);
        return;
      }
      setDidSearch(true);
      void search(trimmedQuery, searchMode);
    },
    [searchQuery, searchMode, search, setSearchResults],
  );

  const handleSearchResultClick = useCallback(
    (path: string, line: number) => {
      setOpenFile(path, line);
      setSearchResults([]);
      setDidSearch(false);
      onFileSelect();
      revealInTree(path);
    },
    [setOpenFile, setSearchResults, revealInTree, onFileSelect],
  );

  return {
    searchQuery,
    setSearchQuery,
    searchMode,
    setSearchMode,
    didSearch,
    setDidSearch,
    searchIme,
    handleSearchSubmit,
    handleSearchResultClick,
  };
}
