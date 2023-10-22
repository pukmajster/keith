import type { AddonId } from './addon'
import type { WriteAddonlistParams } from './addonlist'
import type { GameManifest, RequestGameManifestParams, UninstallAddonsParams } from './manifest'
import type { User } from './user'
import type { ExportVpkOptions } from './vpk'

export interface BridgeApi {
  requestGameManifest: (params: RequestGameManifestParams) => Promise<GameManifest | undefined>
  openLinkInBrowser: (url: string) => void
  writeUserFile: (profileData: User) => void
  readUserFile: () => Promise<User | undefined>
  openWorkingDirectory: () => void
  openDirectoryFinder(): Promise<string | undefined>
  openDirectory(directory: string): Promise<unknown>
  getPath: () => Promise<string>
  getPathJoin: (file: string) => Promise<string>
  writeAddonList: (params: WriteAddonlistParams) => Promise<void>
  extractVpk: (options: ExportVpkOptions) => Promise<void>
  uninstallAddons: (params: UninstallAddonsParams) => Promise<AddonId[]>
}
