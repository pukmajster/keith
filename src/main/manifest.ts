const { VPK } = require('vpk')
import { app } from 'electron'
import * as fs from 'fs'
const path = require('path')
const fsp = fs.promises
const vdf = require('node-vdf')

import {
  Addon,
  AddonFiles,
  AddonId,
  AddonInfo,
  Game,
  GameManifest,
  RequestGameManifestParams
} from 'shared'
import games from 'shared/games'

async function buildGameManifest(params: RequestGameManifestParams): Promise<GameManifest | void> {
  const addons: Addon[] = []
  const game = games[params.appId]
  const addonCategories: GameManifest['addonCategories'] = {
    version: 1,
    categories: {}
  }

  // Fetch the current cached manifest for the specified game
  let cachedManifest: GameManifest | undefined = undefined
  try {
    cachedManifest = await getCachedManifest(params)
  } catch (err) {
    console.log("couldn't build on top of cached manifest")
  }

  if (!game) {
    console.log('game not found')
    return
  }

  const baseGameDirectory = path.join(params.steamGamesDir, 'common', game.rootDirectoryName)

  const fullAddonDirectories = game.addons.addonFoldes.map((addonFolder) =>
    path.join(baseGameDirectory, addonFolder)
  )

  const manifestFileName = path.join(app.getPath('userData'), `${params.appId}_manifest.json`)
  const installedAddons: AddonId[] = []

  try {
    const modDirs: string[] = []
    let files: string[] = []

    for (const addonFolder of fullAddonDirectories) {
      let tempFiles = await fsp.readdir(addonFolder)

      // Get rid of non .vpk files
      tempFiles = tempFiles.filter((file) => file.endsWith('.vpk'))

      // Add the full path to the file
      tempFiles = tempFiles.map((file) => path.join(addonFolder, file))

      files.push(...tempFiles)
    }

    const workshopAddonIdsWithMissingAddonInfo: string[] = []

    for (const file of files) {
      const bIsWorkshopVpk = file.includes('workshop')
      const fileName = file.split('/').at(-1)?.split('.')[0]
      const vpkId = fileName
      const addonId = bIsWorkshopVpk ? `workshop/${vpkId}` : fileName

      if (!vpkId || !addonId) {
        console.log('failed to get vpkId')
        continue
      }

      // Addon vpk is present, add it to the list of installed addons
      installedAddons.push(addonId)

      // Init some VPK variables
      let vpkFiles: AddonFiles = []
      const vpkPath = file
      const vpkStats = await fsp.stat(vpkPath)
      const vpkAddonInfo: AddonInfo = {}

      modDirs.push(vpkPath)

      // Load vpk
      const vpk = new VPK(vpkPath)
      vpk.load()

      // Get all files
      //for (const includedFile of vpk.files) {
      //  if (includedFile.includes('addoninfo.txt')) continue
      //  if (includedFile.includes('addonimage.jpg')) continue
      //  vpkFiles.push(includedFile)
      //}

      // Save all file directories, including addoninfo.txt and addonimage.jpg
      vpkFiles = vpk.files

      // Get addon info
      try {
        const addoninfoFile = vpk.getFile('addoninfo.txt')
        if (!addoninfoFile) {
          throw new Error('Missing addoninfo.txt')
        }

        const addoninfo = addoninfoFile.toString('utf-8')
        const cleanedUpAddonInfo = addoninfo.replace(/^\/\/.*$/gm, '')

        // Read the file buffer and turn it into a string our VDF parser can read
        const addoninfoData = vdf.parse(cleanedUpAddonInfo)?.AddonInfo

        if (!addoninfoData) {
          throw new Error('Missing AddonInfo object in addoninfo.txt')
        }

        // Take a look at the addoninfo.txt file and see what useful information we can snatch
        vpkAddonInfo.title = addoninfoData.addontitle || ''
        vpkAddonInfo.description = addoninfoData.addondescription || ''
        vpkAddonInfo.version = addoninfoData.addonversion || ''
        vpkAddonInfo.author = addoninfoData.addonauthor || ''
        vpkAddonInfo.tagline = addoninfoData.addontagline || ''
        vpkAddonInfo.url = addoninfoData.addonurl0 || ''

        // Check if the addoninfo.txt is missing any of the required fields
        if (!vpkAddonInfo.title) {
          throw new Error('Missing required fields in addoninfo.txt')
        }
      } catch (e) {
        workshopAddonIdsWithMissingAddonInfo.push(vpkId)
        console.log('failed to read vpk addoninfo.txt')
      }

      const addonData: Addon = {
        id: addonId,
        addonInfo: vpkAddonInfo,
        files: vpkFiles,
        vpkId: vpkId,
        vpkTimeLastModified: vpkStats.mtime.toISOString(),
        vpkSizeInBytes: vpkStats.size,
        vpkHash: '',
        fromWorkshop: false,
        workshopId: 0
      }

      // Check if the addon is from the workshop. And if it is, get the workshop id
      if (bIsWorkshopVpk) {
        addonData.workshopId = +vpkId
        addonData.fromWorkshop = true
      }

      addonCategories.categories[addonId] = categorizeVpk(game, vpkFiles)
      addons.push(addonData)
    }

    console.log(`${workshopAddonIdsWithMissingAddonInfo.length} addons missing addoninfo.txt`)
    console.log(workshopAddonIdsWithMissingAddonInfo)

    // Fetch addon info from Steam API
    if (params.onlineMetadataFetching && workshopAddonIdsWithMissingAddonInfo.length > 0) {
      const fd = new FormData()
      let i = 0
      fd.append('itemcount', `${workshopAddonIdsWithMissingAddonInfo.length}`)
      for (const id of workshopAddonIdsWithMissingAddonInfo) {
        fd.append(`publishedfileids[${i}]`, id)
        i++
      }

      console.log('Fetching mod titles from Steam Workshop...')

      try {
        const res = await fetch(
          'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1',
          {
            body: fd,
            method: 'POST'
          }
        )
        const data: IOnlineAddoninfoResponse = await res.json()

        console.log(JSON.stringify(data, null, 2))

        for (const publishedFile of data.response?.publishedfiledetails) {
          const id = publishedFile.publishedfileid.toString()
          if (workshopAddonIdsWithMissingAddonInfo.includes(id)) {
            let addonToModify = addons.find((addon) => addon.id === id)
            if (!addonToModify) continue
            addonToModify.addonInfo = {
              title: publishedFile.title,
              description: publishedFile.description,
              onlineThumbnail: publishedFile.preview_url
            }
          }
        }

        console.log('Successfully retrieved online mod info')
      } catch (e) {
        console.log(e as Error)
        console.log('failed to retrieve online mod info')
      }
    } else {
      console.log('No missing mod titles to fetch')
    }

    // Merge the cached addons and categories with the new ones replacing the old ones
    const cachedAddons = cachedManifest?.addons ?? []
    const cachedCategories = cachedManifest?.addonCategories.categories ?? {}

    const mergedAddons = cachedAddons

    for (const addon of addons) {
      const index = mergedAddons.findIndex((a) => a.id === addon.id)

      if (index === -1) {
        mergedAddons.push(addon)
      } else {
        mergedAddons[index] = addon
      }
    }

    const mergedCategories: GameManifest['addonCategories'] = {
      version: 2,
      categories: {
        ...cachedCategories,
        ...addonCategories.categories
      }
    }

    const manifest: GameManifest = {
      manifestMetadata: {
        version: 1,
        createdAt: cachedManifest?.manifestMetadata.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      appId: params.appId,
      addons: mergedAddons,
      installedAddons,
      addonCategories: mergedCategories
    }

    await fs.promises.writeFile(manifestFileName, JSON.stringify(manifest, null, 2))

    return manifest
  } catch (err) {
    console.log('error reading mods from dir')
  }
}

export async function requestGameManifest(
  params: RequestGameManifestParams
): Promise<GameManifest | undefined> {
  console.log('requestGameManifest', params)

  // let bFailedToReadCachedManifest = false

  if (params.mode === 'cached') {
    console.log('reading cached manifest')

    const manifestFileName = path.join(app.getPath('userData'), `${params.appId}_manifest.json`)

    try {
      const manifest = await fs.promises.readFile(manifestFileName, 'utf-8')
      return JSON.parse(manifest)
    } catch (err) {
      console.log('error reading cached manifest')
    }
  }

  if (params.mode === 'full-update') {
    let manifest = await buildGameManifest(params)
    return manifest ?? undefined
  }

  return undefined
}

async function getCachedManifest(
  params: RequestGameManifestParams
): Promise<GameManifest | undefined> {
  const manifestFileName = path.join(app.getPath('userData'), `${params.appId}_manifest.json`)

  try {
    const manifest = await fs.promises.readFile(manifestFileName, 'utf-8')
    return JSON.parse(manifest)
  } catch (err) {
    console.log('error reading cached manifest')
    throw new Error('error reading cached manifest')
  }
}

// Categorize a VPK file based on its contents and return the categories it belongs as defined in the Game to as an array
function categorizeVpk(game: Game, vpkFiles: AddonFiles): string[] {
  const categories: string[] = []

  for (const category of game.addons.categories) {
    for (const subCategory of category.subCategories) {
      for (const file of vpkFiles) {
        if (subCategory.matches.files.includes(file)) {
          categories.push(subCategory.id)
          categories.push(category.id)
        }
      }

      for (const reference of subCategory.matches.references) {
        for (const file of vpkFiles) {
          if (file.includes(reference)) {
            categories.push(subCategory.id)
            categories.push(category.id)
          }
        }
      }
    }
  }

  // Remove duplicates
  return [...new Set(categories)]
}

// -----------------------------------------------
// Online addon data fetching
// -----------------------------------------------

export interface IPublishedFileDetails {
  publishedfileid: string
  creator?: string
  filename?: string
  file_size?: string
  title: string
  description?: string
  tags?: IPublishedFileDetailsTag[]
  preview_url?: string
}

export interface IPublishedFileDetailsTag {
  tag: string
}

export interface IOnlineAddoninfoResponse {
  response: {
    result: number
    resultcount: number
    publishedfiledetails: IPublishedFileDetails[]
  }
}
