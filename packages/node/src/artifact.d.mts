import type { ComponentOptions } from './index.mjs';
export interface ContainerArtifact { packPath: string; sourceRoot: string; generationRoot?: string }
export interface CompiledArtifact { projectPath: string; miniprogramRootPath?: string; appConfigPath?: string }
export interface ArtifactWatchCallbacks { onRebuilt(artifact: ContainerArtifact): void | Promise<void>; onError(error: unknown): void }
export interface ArtifactWatcher { artifact: ContainerArtifact; generations?: Set<ContainerArtifact>; close(): void | Promise<void> }
export interface ArtifactFactory { build(): ContainerArtifact | Promise<ContainerArtifact>; watch?(callbacks: ArtifactWatchCallbacks): ArtifactWatcher | Promise<ArtifactWatcher> }
export function packArtifact(artifact: CompiledArtifact, options?: Record<string, unknown>): Promise<ContainerArtifact>;
export function componentArtifact(artifact: ContainerArtifact, path: string, options?: ComponentOptions): Promise<ContainerArtifact>;
export function disposeArtifact(artifact: ContainerArtifact): Promise<void>;
export function buildWeappViteArtifact(options?: Record<string, unknown>): Promise<ContainerArtifact>;
export function watchWeappViteArtifact(options?: Record<string, unknown> & Partial<ArtifactWatchCallbacks>): Promise<ArtifactWatcher>;
