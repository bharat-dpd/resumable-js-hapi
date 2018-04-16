'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var fs = require('q-io/fs');
var createReadStream = require('fs').createReadStream;
var path = require('path');
var temporaryFolder = require('os').tmpdir();

var ResumableJsService = function () {
    function ResumableJsService() {
        var options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

        _classCallCheck(this, ResumableJsService);

        this.error = null;
        this.chunkPrefix = options.chunkPrefix || '';
    }

    _createClass(ResumableJsService, [{
        key: '_cleanIdentifier',
        value: function _cleanIdentifier(identifier) {
            return identifier.replace(/^0-9A-Za-z_-/img, '');
        }
    }, {
        key: '_getChunkFilename',
        value: function _getChunkFilename(chunkNumber, identifier) {
            // Clean up the identifier
            identifier = this._cleanIdentifier(identifier);
            // What would the file name be?
            return path.join(temporaryFolder, './' + this.chunkPrefix + 'resumable-' + identifier + '.' + chunkNumber);
        }
    }, {
        key: '_validateRequest',
        value: function _validateRequest(chunkNumber, chunkSize, totalSize, identifier, filename, fileSize) {
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

            if (typeof fileSize !== 'undefined') {
                if (chunkNumber < numberOfChunks && fileSize != chunkSize) {
                    this.error = 'The chunk in the POST request isn\'t the correct size';
                }
                if (numberOfChunks == 1 && fileSize != totalSize) {
                    this.error = 'The file is only a single chunk, and the data size does not fit';
                }
                if (this.error) {
                    return false;
                }
            }

            this.error = null;
            return true;
        }
    }, {
        key: 'getError',
        value: function getError() {
            return this.error;
        }
    }, {
        key: 'setChunkPrefix',
        value: function setChunkPrefix(prefix) {
            this.chunkPrefix = prefix;
            return this;
        }

        // Check if chunk already exists

    }, {
        key: 'get',
        value: function get(req) {
            var _this = this;

            return new Promise(function (resolve, reject) {
                var chunkNumber = req.query.resumableChunkNumber || 0;
                var chunkSize = req.query.resumableChunkSize || 0;
                var totalSize = req.query.resumableTotalSize || 0;
                var identifier = req.query.resumableIdentifier || '';
                var filename = req.query.resumableFilename || '';

                if (_this._validateRequest(chunkNumber, chunkSize, totalSize, identifier, filename)) {
                    var chunkFilename = _this._getChunkFilename(chunkNumber, identifier);
                    fs.exists(chunkFilename).then(function (exists) {
                        if (exists) {
                            resolve({
                                chunkFilename: chunkFilename,
                                filename: filename,
                                identifier: identifier
                            });
                        } else {
                            resolve(false);
                        }
                    }).catch(function (err) {
                        reject(err);
                    });
                } else {
                    reject(_this.getError());
                }
            });
        }

        // Post a chunk

    }, {
        key: 'post',
        value: function post(req) {
            var _this2 = this;

            return new Promise(function (resolve, reject) {
                var fields = req.query;
                var multiparty = require('multiparty');
                var form = new multiparty.Form();
                form.parse(req.payload, function (err, formfields, files) {
                    var file = files.file[0];
                    file.bytes = file.size;
                    var chunkNumber = fields['resumableChunkNumber'];
                    var chunkSize = fields['resumableChunkSize'];
                    var totalSize = fields['resumableTotalSize'];
                    var identifier = _this2._cleanIdentifier(fields['resumableIdentifier'][0]);
                    var filename = fields['resumableFilename'];

                    var originalFilename = fields['resumableIdentifier'];

                    if (!file || !file.bytes) {
                        return reject('File missing');
                    }

                    if (!_this2._validateRequest(chunkNumber, chunkSize, totalSize, identifier, filename, file.bytes)) {
                        return reject(_this2.getError());
                    }

                    var chunkFilename = _this2._getChunkFilename(chunkNumber, identifier);
                    return fs.rename(file.path, chunkFilename).then(function () {
                        // Do we have all the chunks?
                        var currentTestChunk = 1;
                        var numberOfChunks = Math.max(Math.floor(totalSize / (chunkSize * 1.0)), 1);
                        var testChunkExists = function testChunkExists() {
                            return fs.exists(_this2._getChunkFilename(currentTestChunk, identifier)).then(function (exists) {
                                if (exists) {
                                    currentTestChunk += 1;
                                    if (currentTestChunk > numberOfChunks) {
                                        resolve({
                                            complete: true,
                                            filename: filename,
                                            originalFilename: originalFilename,
                                            identifier: identifier
                                        });
                                    } else {
                                        // Recursion
                                        return testChunkExists();
                                    }
                                } else {
                                    resolve({
                                        complete: false,
                                        filename: filename,
                                        originalFilename: originalFilename,
                                        identifier: identifier
                                    });
                                }
                            });
                        };
                        return testChunkExists();
                    }).catch(function (err) {
                        reject(err);
                    });
                });
            });
        }

        // Combine downloaded chunks and pipe them to a writable stream

    }, {
        key: 'write',
        value: function write(identifier, writableStream, options) {
            var _this3 = this;

            return new Promise(function (resolve, reject) {
                options = options || {};
                options.end = typeof options['end'] === 'undefined' ? true : options['end'];

                writableStream.on('error', function (error) {
                    reject(error);
                });

                // Iterate over each chunk
                var pipeChunk = function pipeChunk(number) {
                    var chunkFilename = _this3._getChunkFilename(number, identifier);
                    fs.exists(chunkFilename).then(function (exists) {
                        if (exists) {
                            // If the chunk with the current number exists,
                            // then create a ReadStream from the file
                            // and pipe it to the specified writableStream.
                            var sourceStream = createReadStream(chunkFilename);
                            sourceStream.pipe(writableStream, {
                                end: false
                            });
                            sourceStream.on('end', function () {
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
                    }).catch(function (err) {
                        reject(err);
                    });
                };
                pipeChunk(1);
            });
        }

        // Delete chunks

    }, {
        key: 'clean',
        value: function clean(identifier) {
            var _this4 = this;

            return new Promise(function (resolve, reject) {
                var removePromises = [];
                // Iterate over each chunk
                var pipeChunkRm = function pipeChunkRm(number) {
                    var chunkFilename = _this4._getChunkFilename(number, identifier);
                    fs.exists(chunkFilename).then(function (exists) {
                        if (exists) {
                            removePromises.push(fs.remove(chunkFilename));
                            pipeChunkRm(number + 1);
                        } else {
                            Promise.all(removePromises).then(function (what) {
                                resolve();
                            }).catch(function (err) {
                                reject(err);
                            });
                        }
                    }).catch(function (err) {
                        reject(err);
                    });
                };
                pipeChunkRm(1);
            });
        }
    }]);

    return ResumableJsService;
}();

module.exports = ResumableJsService;