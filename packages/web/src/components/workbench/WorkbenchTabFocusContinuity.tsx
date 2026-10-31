'use client';

import { Component, type ReactNode, type RefCallback } from 'react';
import { resolveFileTarget } from './real-surface-adapters';
import type { WorkbenchLayoutState, WorkspaceSurfaceDescriptor } from './workbench-contract';

interface Props {
  layout: WorkbenchLayoutState;
  scopeKey: string;
  children: (rootRef: RefCallback<HTMLElement>) => ReactNode;
}

interface FocusSnapshot {
  element: HTMLButtonElement;
  destinationId: string;
  control: string;
  destination: WorkspaceSurfaceDescriptor;
  scopeKey: string;
  popup: HTMLElement | null;
  deferred?: boolean;
}

const isCanonicalWorkspaceRoot = (value: string) => /^f063_root_v1_[a-f0-9]{64}$/.test(value);

/** Capture before React removes an alias tab; restore its named control in the same commit. */
export class WorkbenchTabFocusContinuity extends Component<Props, Record<string, never>, FocusSnapshot | null> {
  private root: HTMLElement | null = null;
  private pending: FocusSnapshot | null = null;
  private setRoot: RefCallback<HTMLElement> = (node) => {
    this.root = node;
  };

  private getFocusRoots(): HTMLElement[] {
    if (!this.root) return [];
    // Overflow tabs live in the original header's explicitly owned menu portal.
    const portals = Array.from(this.root.querySelectorAll<HTMLElement>('[aria-controls]')).flatMap((trigger) => {
      const popup = document.getElementById(trigger.getAttribute('aria-controls') ?? '');
      return popup ? [popup] : [];
    });
    return [this.root, ...portals];
  }

  getSnapshotBeforeUpdate(previous: Props): FocusSnapshot | null {
    const pending = this.pending;
    this.pending = null;
    if (
      pending &&
      document.activeElement === document.body &&
      pending.scopeKey === this.props.scopeKey &&
      this.props.layout.surfaces.find((surface) => surface.id === this.props.layout.activeSurfaceId) ===
        pending.destination &&
      pending.popup?.isConnected &&
      !pending.popup.hidden
    )
      return { ...pending, deferred: true };
    if (previous.scopeKey !== this.props.scopeKey) return null;
    const element = document.activeElement;
    if (!(element instanceof HTMLButtonElement) || !this.getFocusRoots().some((root) => root.contains(element)))
      return null;
    const control = element.dataset.workbenchTabControl;
    const sourceId = element.closest<HTMLElement>('[data-tab-surface-id]')?.dataset.tabSurfaceId;
    if (!control || sourceId !== previous.layout.activeSurfaceId) return null;
    const source = previous.layout.surfaces.find((surface) => surface.id === sourceId);
    const destination = this.props.layout.surfaces.find((surface) => surface.id === this.props.layout.activeSurfaceId);
    if (!source || !destination || source.navigationOrigin !== destination.navigationOrigin) return null;
    const snapshot = {
      element,
      destinationId: destination.id,
      control,
      destination,
      scopeKey: this.props.scopeKey,
      popup: element.closest<HTMLElement>('[data-v2-workspace-menu]'),
    };
    if (this.props.layout.surfaces.some((surface) => surface.id === sourceId)) {
      // Inline/overflow measurement can move this same admitted tab between parents.
      if (
        destination.id !== sourceId ||
        source.objectRef.kind !== destination.objectRef.kind ||
        source.objectRef.id !== destination.objectRef.id ||
        source.ownerStateRef.owner !== destination.ownerStateRef.owner ||
        source.ownerStateRef.key !== destination.ownerStateRef.key
      )
        return null;
      return snapshot;
    }
    const before = resolveFileTarget(source);
    const after = resolveFileTarget(destination);
    if (
      !before ||
      !after ||
      before.path !== after.path ||
      isCanonicalWorkspaceRoot(before.worktreeId) ||
      !isCanonicalWorkspaceRoot(after.worktreeId)
    )
      return null;
    return snapshot;
  }

  componentDidUpdate(_previous: Props, _state: Record<string, never>, snapshot: FocusSnapshot | null) {
    if (!snapshot || snapshot.element.isConnected || document.activeElement !== document.body) return;
    if (snapshot.popup && (!snapshot.popup.isConnected || snapshot.popup.hidden)) return;
    const roots = snapshot.popup ? [snapshot.popup] : this.getFocusRoots();
    const tab = roots
      .flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>('[data-tab-surface-id]')))
      .find((node) => node.dataset.tabSurfaceId === snapshot.destinationId);
    const control = Array.from(tab?.querySelectorAll<HTMLButtonElement>('[data-workbench-tab-control]') ?? []).find(
      (node) => node.dataset.workbenchTabControl === snapshot.control,
    );
    if (control && !control.disabled && !control.closest('[hidden]')) control.focus({ preventScroll: true });
    else if (snapshot.popup && !snapshot.deferred) {
      // The original width measurement temporarily renders all tabs inline. Keep
      // this exact open portal's focus only through its next synchronous commit.
      this.pending = snapshot;
    }
  }

  render() {
    // A render callback binds the original header/rail, without adding a layout wrapper.
    return this.props.children(this.setRoot);
  }
}
