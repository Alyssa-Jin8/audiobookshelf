const fs = require('../libs/fsExtra')
const Path = require('path')
const Logger = require('../Logger')
const readChunk = require('../libs/readChunk')
const imageType = require('../libs/imageType')

const globals = require('../utils/globals')
const { downloadImageFile, filePathToPOSIX, checkPathIsFile } = require('../utils/fileUtils')
const { extractCoverArt } = require('../utils/ffmpegHelpers')
const parseEbookMetadata = require('../utils/parsers/parseEbookMetadata')

const CacheManager = require('../managers/CacheManager')

class CoverManager {
  constructor() {}

  getCoverDirectory(libraryItem) {
    if (global.ServerSettings.storeCoverWithItem && !libraryItem.isFile) {
      return libraryItem.path
    } else {
      return Path.posix.join(Path.posix.join(global.MetadataPath, 'items'), libraryItem.id)
    }
  }

  getFilesInDirectory(dir) {
    try {
      return fs.readdir(dir)
    } catch (error) {
      Logger.error(`[CoverManager] Failed to get files in dir ${dir}`, error)
      return []
    }
  }

  removeFile(filepath) {
    try {
      return fs.pathExists(filepath).then((exists) => {
        if (!exists) Logger.warn(`[CoverManager] Attempting to remove file that does not exist ${filepath}`)
        return exists ? fs.unlink(filepath) : false
      })
    } catch (error) {
      Logger.error(`[CoverManager] Failed to remove file "${filepath}"`, error)
      return false
    }
  }

  // Remove covers that dont have the same filename as the new cover
  async removeOldCovers(dirpath, newCoverExt) {
    var filesInDir = await this.getFilesInDirectory(dirpath)

    const imageExtensions = ['.jpeg', '.jpg', '.png', '.webp', '.jiff']
    for (let i = 0; i < filesInDir.length; i++) {
      var file = filesInDir[i]
      var _extname = Path.extname(file).toLowerCase()
      var _filename = Path.basename(file, _extname).toLowerCase()
      if (_filename === 'cover' && _extname !== newCoverExt && imageExtensions.includes(_extname)) {
        var filepath = Path.join(dirpath, file)
        Logger.debug(`[CoverManager] Removing old cover from metadata "${filepath}"`)
        await this.removeFile(filepath)
      }
    }
  }

  async checkFileIsValidImage(imagepath, removeOnInvalid = false) {
    const buffer = await readChunk(imagepath, 0, 12)
    const imgType = imageType(buffer)
    if (!imgType) {
      if (removeOnInvalid) await this.removeFile(imagepath)
      return {
        error: 'Invalid image'
      }
    }

    if (!globals.SupportedImageTypes.includes(imgType.ext)) {
      if (removeOnInvalid) await this.removeFile(imagepath)
      return {
        error: `Invalid image type ${imgType.ext} (Supported: ${globals.SupportedImageTypes.join(',')})`
      }
    }
    return imgType
  }

  async uploadCover(libraryItem, coverFile) {
    const extname = Path.extname(coverFile.name.toLowerCase())

    // 检查是否是支持的图片类型
    if (!extname || !globals.SupportedImageTypes.includes(extname.slice(1))) {
      return {
        error: `Invalid image type ${extname} (Supported: ${globals.SupportedImageTypes.join(',')})`
      }
    }

    const coverDirPath = this.getCoverDirectory(libraryItem)
    await fs.ensureDir(coverDirPath)

    // 初始化封面路径
    let coverFullPath = Path.posix.join(coverDirPath, `cover${extname}`)

    // 检查是否存在相同文件名的封面
    if (await fs.pathExists(coverFullPath)) {
      // 如果文件存在，生成一个唯一文件名，避免覆盖旧文件
      const uniqueSuffix = Date.now() // 使用时间戳生成唯一文件名
      coverFullPath = Path.posix.join(coverDirPath, `cover_${uniqueSuffix}${extname}`)
    }

    // 将封面从临时上传目录移动到目标目录
    const success = await coverFile
      .mv(coverFullPath)
      .then(() => true)
      .catch((error) => {
        Logger.error('[CoverManager] Failed to move cover file', coverFullPath, error)
        return false
      })

    if (!success) {
      return {
        error: 'Failed to move cover into destination'
      }
    }

    // 获取所有封面文件并返回
    const allFiles = await this.getFilesInDirectory(coverDirPath)
    const imageFiles = allFiles.filter((file) => globals.SupportedImageTypes.includes(Path.extname(file).slice(1)))

    // 刷新封面缓存
    await CacheManager.purgeCoverCache(libraryItem.id)

    Logger.info(`[CoverManager] Uploaded libraryItem cover "${coverFullPath}" for "${libraryItem.media.metadata.title}"`)

    // 更新封面路径
    libraryItem.updateMediaCover(coverFullPath)

    // 返回上传的封面路径和所有封面列表
    return {
      cover: coverFullPath, // 返回当前上传的封面
      allCovers: imageFiles.map((file) => ({
        filePath: Path.posix.join(coverDirPath, file), // 返回文件的完整路径
        fileName: file
      })) // 返回所有封面文件列表
    }
  }
  async downloadCoverFromUrl(libraryItem, url, forceLibraryItemFolder = false) {
    try {
      // Force save cover with library item is used for adding new podcasts
      var coverDirPath = forceLibraryItemFolder ? libraryItem.path : this.getCoverDirectory(libraryItem)
      await fs.ensureDir(coverDirPath)

      var temppath = Path.posix.join(coverDirPath, 'cover')

      let errorMsg = ''
      let success = await downloadImageFile(url, temppath)
        .then(() => true)
        .catch((err) => {
          errorMsg = err.message || 'Unknown error'
          Logger.error(`[CoverManager] Download image file failed for "${url}"`, errorMsg)
          return false
        })
      if (!success) {
        return {
          error: 'Failed to download image from url: ' + errorMsg
        }
      }

      var imgtype = await this.checkFileIsValidImage(temppath, true)

      if (imgtype.error) {
        return imgtype
      }

      var coverFilename = `cover.${imgtype.ext}`
      var coverFullPath = Path.posix.join(coverDirPath, coverFilename)
      await fs.rename(temppath, coverFullPath)

      await this.removeOldCovers(coverDirPath, '.' + imgtype.ext)
      await CacheManager.purgeCoverCache(libraryItem.id)

      Logger.info(`[CoverManager] Downloaded libraryItem cover "${coverFullPath}" from url "${url}" for "${libraryItem.media.metadata.title}"`)
      libraryItem.updateMediaCover(coverFullPath)
      return {
        cover: coverFullPath
      }
    } catch (error) {
      Logger.error(`[CoverManager] Fetch cover image from url "${url}" failed`, error)
      return {
        error: 'Failed to fetch image from url'
      }
    }
  }

  async validateCoverPath(coverPath, libraryItem) {
    // Invalid cover path
    if (!coverPath || coverPath.startsWith('http:') || coverPath.startsWith('https:')) {
      Logger.error(`[CoverManager] validate cover path invalid http url "${coverPath}"`)
      return {
        error: 'Invalid cover path'
      }
    }
    coverPath = filePathToPOSIX(coverPath)
    // Cover path already set on media
    if (libraryItem.media.coverPath == coverPath) {
      Logger.debug(`[CoverManager] validate cover path already set "${coverPath}"`)
      return {
        cover: coverPath,
        updated: false
      }
    }

    // Cover path does not exist
    if (!(await fs.pathExists(coverPath))) {
      Logger.error(`[CoverManager] validate cover path does not exist "${coverPath}"`)
      return {
        error: 'Cover path does not exist'
      }
    }

    // Cover path is not a file
    if (!(await checkPathIsFile(coverPath))) {
      Logger.error(`[CoverManager] validate cover path is not a file "${coverPath}"`)
      return {
        error: 'Cover path is not a file'
      }
    }

    // Check valid image at path
    var imgtype = await this.checkFileIsValidImage(coverPath, false)
    if (imgtype.error) {
      return imgtype
    }

    var coverDirPath = this.getCoverDirectory(libraryItem)

    // Cover path is not in correct directory - make a copy
    if (!coverPath.startsWith(coverDirPath)) {
      await fs.ensureDir(coverDirPath)

      var coverFilename = `cover.${imgtype.ext}`
      var newCoverPath = Path.posix.join(coverDirPath, coverFilename)
      Logger.debug(`[CoverManager] validate cover path copy cover from "${coverPath}" to "${newCoverPath}"`)

      var copySuccess = await fs
        .copy(coverPath, newCoverPath, { overwrite: true })
        .then(() => true)
        .catch((error) => {
          Logger.error(`[CoverManager] validate cover path failed to copy cover`, error)
          return false
        })
      if (!copySuccess) {
        return {
          error: 'Failed to copy cover to dir'
        }
      }
      await this.removeOldCovers(coverDirPath, '.' + imgtype.ext)
      Logger.debug(`[CoverManager] cover copy success`)
      coverPath = newCoverPath
    }

    await CacheManager.purgeCoverCache(libraryItem.id)

    libraryItem.updateMediaCover(coverPath)
    return {
      cover: coverPath,
      updated: true
    }
  }

  /**
   * Extract cover art from audio file and save for library item
   *
   * @param {import('../models/Book').AudioFileObject[]} audioFiles
   * @param {string} libraryItemId
   * @param {string} [libraryItemPath] null for isFile library items
   * @returns {Promise<string>} returns cover path
   */
  async saveEmbeddedCoverArt(audioFiles, libraryItemId, libraryItemPath) {
    let audioFileWithCover = audioFiles.find((af) => af.embeddedCoverArt)
    if (!audioFileWithCover) return null

    let coverDirPath = null
    if (global.ServerSettings.storeCoverWithItem && libraryItemPath) {
      coverDirPath = libraryItemPath
    } else {
      coverDirPath = Path.posix.join(global.MetadataPath, 'items', libraryItemId)
    }
    await fs.ensureDir(coverDirPath)

    const coverFilename = audioFileWithCover.embeddedCoverArt === 'png' ? 'cover.png' : 'cover.jpg'
    const coverFilePath = Path.join(coverDirPath, coverFilename)

    const coverAlreadyExists = await fs.pathExists(coverFilePath)
    if (coverAlreadyExists) {
      Logger.warn(`[CoverManager] Extract embedded cover art but cover already exists for "${coverFilePath}" - bail`)
      return null
    }

    const success = await extractCoverArt(audioFileWithCover.metadata.path, coverFilePath)
    if (success) {
      await CacheManager.purgeCoverCache(libraryItemId)
      return coverFilePath
    }
    return null
  }

  /**
   * Extract cover art from ebook and save for library item
   *
   * @param {import('../utils/parsers/parseEbookMetadata').EBookFileScanData} ebookFileScanData
   * @param {string} libraryItemId
   * @param {string} [libraryItemPath] null for isFile library items
   * @returns {Promise<string>} returns cover path
   */
  async saveEbookCoverArt(ebookFileScanData, libraryItemId, libraryItemPath) {
    if (!ebookFileScanData?.ebookCoverPath) return null

    let coverDirPath = null
    if (global.ServerSettings.storeCoverWithItem && libraryItemPath) {
      coverDirPath = libraryItemPath
    } else {
      coverDirPath = Path.posix.join(global.MetadataPath, 'items', libraryItemId)
    }
    await fs.ensureDir(coverDirPath)

    let extname = Path.extname(ebookFileScanData.ebookCoverPath) || '.jpg'
    if (extname === '.jpeg') extname = '.jpg'
    const coverFilename = `cover${extname}`
    const coverFilePath = Path.join(coverDirPath, coverFilename)

    // TODO: Overwrite if exists?
    const coverAlreadyExists = await fs.pathExists(coverFilePath)
    if (coverAlreadyExists) {
      Logger.warn(`[CoverManager] Extract embedded cover art but cover already exists for "${coverFilePath}" - overwriting`)
    }

    const success = await parseEbookMetadata.extractCoverImage(ebookFileScanData, coverFilePath)
    if (success) {
      await CacheManager.purgeCoverCache(libraryItemId)
      return coverFilePath
    }
    return null
  }

  /**
   *
   * @param {string} url
   * @param {string} libraryItemId
   * @param {string} [libraryItemPath] null if library item isFile or is from adding new podcast
   * @returns {Promise<{error:string}|{cover:string}>}
   */
  async downloadCoverFromUrlNew(url, libraryItemId, libraryItemPath) {
    try {
      let coverDirPath = null
      if (global.ServerSettings.storeCoverWithItem && libraryItemPath) {
        coverDirPath = libraryItemPath
      } else {
        coverDirPath = Path.posix.join(global.MetadataPath, 'items', libraryItemId)
      }

      await fs.ensureDir(coverDirPath)

      const temppath = Path.posix.join(coverDirPath, 'cover')
      const success = await downloadImageFile(url, temppath)
        .then(() => true)
        .catch((err) => {
          Logger.error(`[CoverManager] Download image file failed for "${url}"`, err)
          return false
        })
      if (!success) {
        return {
          error: 'Failed to download image from url'
        }
      }

      const imgtype = await this.checkFileIsValidImage(temppath, true)
      if (imgtype.error) {
        return imgtype
      }

      const coverFullPath = Path.posix.join(coverDirPath, `cover.${imgtype.ext}`)
      await fs.rename(temppath, coverFullPath)

      await this.removeOldCovers(coverDirPath, '.' + imgtype.ext)
      await CacheManager.purgeCoverCache(libraryItemId)

      Logger.info(`[CoverManager] Downloaded libraryItem cover "${coverFullPath}" from url "${url}"`)
      return {
        cover: coverFullPath
      }
    } catch (error) {
      Logger.error(`[CoverManager] Fetch cover image from url "${url}" failed`, error)
      return {
        error: 'Failed to fetch image from url'
      }
    }
  }
}
module.exports = new CoverManager()
