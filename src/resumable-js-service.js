var fs = require('q-io/fs');
var createReadStream = require('fs').createReadStream;
var path = require('path');
var temporaryFolder = require('os').tmpdir();

class ResumableJsService {
    constructor(options = {}) {
        this.error = null;
        this.chunkPrefix = options.chunkPrefix || '';

    }

    _cleanIdentifier(identifier) {
        return identifier.replace(/^0-9A-Za-z_-/img, '');
    }

    _getChunkFilename(chunkNumber, identifier) {
        // Clean up the identifier
        identifier = this._cleanIdentifier(identifier);
        // What would the file name be?
        return path.join(temporaryFolder, `./${this.chunkPrefix}resumable-${identifier}.${chunkNumber}`);
    }

    _validateRequest(chunkNumber, chunkSize, totalSize, identifier, filename, fileSize) {
        // Clean up the identifier
        identifier = this._cleanIdentifier(identifier);

        // Check if the request is sane
        if (chunkNumber < 1 || chunkSize < 1 || totalSize < 1 || identifier.length === 0 || filename.length === 0) {
            this.error = 'Not a valid resumable request';
            return false;
        }

        var numberOfChunks = Math.max(Math.floor(totalSize / (chunkSize * 1.0)), 1);
        if (chunkNumber > numberOfChunks) {
            this.error = 'Invalid chunk number';
            return false;
        }

        if (typeof(fileSize) !== 'undefined') {
            if (chunkNumber < numberOfChunks && fileSize != chunkSize) {
                this.error = `The chunk in the POST request isn't the correct size`;
            }
            if (numberOfChunks == 1 && fileSize != totalSize) {
                this.error = `The file is only a single chunk, and the data size does not fit`;
            }
            if (this.error) {
                return false;
            }
        }

        this.error = null;
        return true;
    }

    getError() {
        return this.error;
    }

    setChunkPrefix(prefix) {
        this.chunkPrefix = prefix;
        return this;
    }

    // Check if chunk already exists
    get(req) {
        return new Promise((resolve, reject) => {
            var chunkNumber = req.query.resumableChunkNumber || 0;
            var chunkSize = req.query.resumableChunkSize || 0;
            var totalSize = req.query.resumableTotalSize || 0;
            var identifier = req.query.resumableIdentifier || '';
            var filename = req.query.resumableFilename || '';

            if (this._validateRequest(chunkNumber, chunkSize, totalSize, identifier, filename)) {
                var chunkFilename = this._getChunkFilename(chunkNumber, identifier);
                fs.exists(chunkFilename).then(exists => {
                    if (exists){
                        resolve({
                            chunkFilename,
                            filename,
                            identifier,
                        });
                    } else {
                        resolve(false);
                    }
                }).catch(err => {
                    reject(err);
                });
            } else {
                reject(this.getError());
            }
        });
    }

    // Post a chunk
    post(req) {
        return new Promise((resolve, reject) => {
            var fields =req.query;
            var multiparty = require('multiparty');
            var form = new multiparty.Form();
            form.parse(req.payload, (err, formfields, files)=> {
                var file = files.file[0];
                file.bytes = file.size;
                var chunkNumber = fields['resumableChunkNumber'];
                var chunkSize = fields['resumableChunkSize'];
                var totalSize = fields['resumableTotalSize'];
                var identifier = this._cleanIdentifier(fields['resumableIdentifier'][0]);
                var filename = fields['resumableFilename'];
    
                var originalFilename = fields['resumableIdentifier'];
    
                if (! file || ! file.bytes) {
                    return reject('File missing');
                }
    
                if (! this._validateRequest(
                        chunkNumber,
                        chunkSize,
                        totalSize,
                        identifier,
                        filename,
                        file.bytes
                )) {
                    return reject(this.getError());
                }
    
                var chunkFilename = this._getChunkFilename(chunkNumber, identifier);
                return fs.rename(file.path, chunkFilename).then(() => {
                    // Do we have all the chunks?
                    var currentTestChunk = 1;
                    var numberOfChunks = Math.max(Math.floor(totalSize / (chunkSize * 1.0)), 1);
                    var testChunkExists = () => {
                        return fs.exists(this._getChunkFilename(currentTestChunk, identifier)).then(exists => {
                            if (exists) {
                                currentTestChunk += 1;
                                if (currentTestChunk>numberOfChunks) {
                                    resolve({
                                        complete: true,
                                        filename,
                                        originalFilename,
                                        identifier,
                                    });
                                } else {
                                    // Recursion
                                    return testChunkExists();
                                }
                            } else {
                                resolve({
                                    complete: false,
                                    filename,
                                    originalFilename,
                                    identifier,
                                });
                            }
                        });
                    };
                    return testChunkExists();
                }).catch(err => {
                    reject(err);
                });
            });
        });
    }

    // Combine downloaded chunks and pipe them to a writable stream
    write(identifier, writableStream, options) {
        return new Promise((resolve, reject) => {
            options = options || {};
            options.end = (typeof options['end'] === 'undefined' ? true : options['end']);

            writableStream.on('error', error => {
                reject(error);
            });

            // Iterate over each chunk
            var pipeChunk = number => {
                var chunkFilename = this._getChunkFilename(number, identifier);
                fs.exists(chunkFilename).then(exists => {
                    if (exists) {
                        // If the chunk with the current number exists,
                        // then create a ReadStream from the file
                        // and pipe it to the specified writableStream.
                        var sourceStream = createReadStream(chunkFilename);
                        sourceStream.pipe(writableStream, {
                            end: false
                        });
                        sourceStream.on('end', function() {
                            // When the chunk is fully streamed,
                            // jump to the next one
                            pipeChunk(number + 1);
                        });
                    } else {
                        if (options.end) {
                            writableStream.end();
                        }
                        resolve();
                    }
                }).catch(err => {
                    reject(err);
                });
            };
            pipeChunk(1);
        });
    }

    // Delete chunks
    clean(identifier) {
        return new Promise((resolve, reject) => {
            var removePromises = [];
            // Iterate over each chunk
            var pipeChunkRm = number => {
                var chunkFilename = this._getChunkFilename(number, identifier);
                fs.exists(chunkFilename).then(exists => {
                    if (exists) {
                        removePromises.push(
                            fs.remove(chunkFilename)
                        );
                        pipeChunkRm(number + 1);
                    } else {
                        Promise.all(removePromises)
                            .then((what) => {
                                resolve();
                            })
                            .catch(err => {
                                reject(err);
                            });
                    }
                }).catch(err => {
                    reject(err);
                });
            };
            pipeChunkRm(1);
        });
    }
}

module.exports = ResumableJsService;
