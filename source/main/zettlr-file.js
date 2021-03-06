/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ZettlrFile class
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains the ZettlrFile class, modeling a file on
 *                  disk for the app.
 *
 * END HEADER
 */

const fs                    = require('fs');
const path                  = require('path');
const sanitize              = require('sanitize-filename');
const {shell}               = require('electron');
const {hash, ignoreFile}    = require('../common/zettlr-helpers.js');
const {trans}               = require('../common/lang/i18n.js');

/**
 * Error Object
 * @param       {String} msg The error message
 * @constructor
 */
function FileError(msg) {
    this.name = 'File error';
    this.msg = msg;
}

/**
 * Model for accessing files on the filesystem. This class is also capable of
 * keeping autosave files and reverting to certain states.
 */
class ZettlrFile
{
    /**
     * Create the model by reading the file on disk.
     * @param {ZettlrDir} parent       The containing directory model
     * @param {String} fname        The full path to the file to be read
     */
    constructor(parent, fname)
    {
        this.parent       = parent;
        this.dir          = ''; // Containing dir
        this.name         = '';
        this.path         = '';
        this.hash         = null;
        this.id           = ''; // The ID, if there is one inside the file.
        this.tags         = []; // All tags that are to be found inside the file's contents.
        this.type         = 'file';
        this.ext          = '';
        this.modtime      = 0;
        this.snippet      = '';
        // This variable is only used to transfer the file contents to and from
        // the renderer. It will be empty all other times, because otherwise the
        // RAM will fill up pretty fast.
        this.content      = '';
        this._vd          = []; // This array holds all virtual directories in which the file is also present. Necessary to inform them of renames etc.

        // Prepopulate
        this.path = fname;
        this.name = path.basename(this.path);
        this.hash = hash(this.path);
        this.ext  = path.extname(this.path);
        this.dir = this.parent.name; // Containing dir

        // The file might've been just created. Test that
        try {
            let stat = fs.lstatSync(this.path);
        }catch(e) {
            // Error? -> create
            fs.writeFileSync(this.path, '', { encoding: "utf8" });
        }

        this.read();

        if(this.isRoot()) {
            // We have to add our file to the watchdog
            this.parent.getWatchdog().addPath(this.path);
        }

    }

    /**
     * This function is always called when the app closes. It can be used to
     * perform closing activity.
     * @return {void} Does not return anything.
     */
    shutdown()
    {
        // Such empty
    }

    /**
     * Handles an event emitted by the watchdog
     * @param  {String} p The path to test against
     * @param  {String} e The event to handle
     */
    handleEvent(p, e)
    {
        if(this.isScope(p) === this) {
            // Only in this case may we handle the event. Possible events:
            // change, unlink
            if(e === 'change') {
                this.update().parent.notifyChange(`File ${this.name} has changed remotely.`);
            } else if(e === 'unlink') {
                this.parent.notifyChange(trans('system.file_removed', this.name));
                this.remove();
            }
        }
    }

    /**
     * Reads the file and returns its contents. Also updates snippet but does
     * not keep the contents in buffer (saving memory)
     * @return {String} The file contents as string.
     */
    read()
    {
        let stat = fs.lstatSync(this.path);
        this.modtime = stat.mtime.getTime();

        // We cannot use RegEx, as negative lookbehind is not supported (yet,
        // so we have to do it the ugly way: ITERATE OVER THE TEXT!)
        //
        // For further reference (as soon as it gets implemented; the proposal
        // is from March 21, 2018 (lel), here the correct regex needed:)
        // let idRE = /(?<!\[\[)@ID:(.*)(?!\]\])/g
        let idRE = /@ID:([^\s]*)/g;
        let tagRE = /#([A-Z0-9-_]+)/gi;
        let match;


        // (Re-)read content of file
        let cnt = fs.readFileSync(this.path, { encoding: "utf8" });
        this.snippet = (cnt.length > 50) ? cnt.substr(0, 50) + '…' : cnt ;

        // Now read all tags
        this.tags = [];
        while((match = tagRE.exec(cnt)) != null) {
            let tag = match[1];
            tag = tag.replace(/#/g, ''); // Prevent headings levels 2-6 from showing up in the tag list
            if(tag.length > 0) {
                this.tags.push(match[1].toLowerCase());
            }
        }
        // Remove duplicates
        this.tags = [...new Set(this.tags)];

        // Search for an ID
        if((match = idRE.exec(cnt)) == null) {
            return cnt;
        }

        let index = 0;
        do {
            if(cnt.substr(match.index-2, match.index) != '[[') {
                // Found the first ID. Precedence should go to the first found.
                break;
            }
        } while((match = idRE.exec(cnt)) != null);

        if((match != null) && (match[1].substr(-2) != ']]')) {
            this.id = match[1] || '';
        }

        return cnt;
    }

    /**
     * Update the parameters of the model based on the file on disk.
     * @return {ZettlrFile} Return this for chainability
     */
    update()
    {
        // The file has changed remotely -> re-read
        this.read();

        return this;
    }

    /**
     * Returns the file content if hashes match
     * @param  {Integer} hash The file hash
     * @return {Mixed}      Either the file's contents or null
     */
    get(hash)
    {
        if(this.hash == hash) {
            return this.read();
        }
        return null;
    }

    /**
     * The object should return itself with content included. Does not keep it in buffer!
     * @return {ZettlrFile} A clone of this with content.
     */
    withContent()
    {
        // We need to duplicate the file object, because otherwise the content
        // will remain in the RAM. If you open a lot files during one session
        // with Zettlr it will gradually fill up all space, rendering your
        // computer more and more slow.
        return {
            'dir'          : this.dir, // Containing dir
            'name'         : this.name,
            'path'         : this.path,
            'hash'         : this.hash,
            'id'           : this.id, // The ID, if there is one inside the file.
            'type'         : this.type,
            'ext'          : this.ext,
            'modtime'      : this.modtime,
            'snippet'      : this.snippet,
            'content'      : this.read(), // Will only be not empty when the file is modified.
        };

        Object.assign(f, this);
        f.content = this.read();
        return f;
    }

    /**
     * Returns this or null based on whether this is the correct file.
     * @param  {object} obj The object containing a hash or a path
     * @return {Mixed}     this or null
     */
    findFile(obj)
    {
        let prop = '';

        if(obj.hasOwnProperty('path') && obj.path != null) {
            prop = 'path';
        } else if(obj.hasOwnProperty('hash') && obj.hash != null) {
            prop = 'hash';
        } else {
            throw new FileError('Cannot findFile!');
        }

        if(this[prop] == obj[prop]) {
            return this;
        }

        // This is not the file you are looking for.
        return null;
    }

    /**
     * Either returns this, if the ID matches the term, or null
     * @param  {String} term The ID-term to be searched for
     * @return {ZettlrFile}      This or null.
     */
    findExact(term)
    {
        let name = this.name.substr(0, this.name.length - this.ext.length);
        let titleFound = (name.toLowerCase() === term.toLowerCase()) ? true : false;
        // Remove a possible @ID: in the term
        if(term.indexOf(':') > -1) {
            term = term.split(':')[1];
        }

        // Return ID exact match or title exact match. Or null, if nothing found.
        return (this.id === term) ? this : (titleFound) ? this : null;
    }

    /**
     * Writes the buffer to the file and clears the buffer.
     * @return {ZettlrFile} this
     */
    save(cnt)
    {
        fs.writeFileSync(this.path, cnt, { encoding: "utf8" });

        // Last but not least: Retrieve all changed information by re-reading
        // the file again.
        this.read();

        return this;
    }

    /**
     * Removes the file from disk and also from containing dir.
     * @return {Boolean} The return value of the remove operation on parent
     */
    remove()
    {
        shell.moveItemToTrash(this.path);
        // Notify the virtual directories that this file is now in the trash
        // (also a virtual directory, but not quite the same).
        this.removeFromVD();
        return this.parent.remove(this);
    }

    /**
     * Renames the file on disk
     * @param  {string} name The new name (not path!)
     * @param {ZettlrWatchdog} [watchdog=null] The watchdog instance to ignore the events if possible
     * @return {ZettlrFile}      this for chainability.
     */
    rename(name, watchdog = null)
    {
        name = sanitize(name);

        // Rename this file.
        if((name == null) || (name == '')) {
            throw new FileError('The new name did not contain any allowed characters.');
        }

        // Make sure we got an extension.
        if(ignoreFile(name)) {
            name += '.md';
        }

        // Rename
        this.name = name;
        let newpath = path.join(path.dirname(this.path), this.name);

        // If the watchdog is given, ignore the generated events pre-emptively
        if(watchdog != null) {
            watchdog.ignoreNext('unlink', this.path);
            watchdog.ignoreNext('add', newpath);
        }
        fs.renameSync(this.path, newpath);
        this.path = newpath;
        this.hash = hash(this.path);

        // Let the parent sort itself again to reflect possible changes in order.
        this.parent.sort();

        // Notify virtualDirectories of the path change.
        this._notifyVD();

        // Chainability
        return this;
    }

    /**
     * Move a file to another directory
     * @param  {String} toPath The new directory's path
     * @return {ZettlrFile}        this for chainability.
     */
    move(toPath)
    {
        // First detach the object.
        this.detach();

        // Find new path:
        let oldPath = this.path;
        this.path = path.join(toPath, this.name);
        this.hash = hash(this.path);

        // Move
        fs.renameSync(oldPath, this.path);

        // Notify virtualDirectories of the path change.
        this._notifyVD();

        // Chainability
        return this;
    }

    /**
     * Detach this object from its containing directory.
     * @return {ZettlrFile} this for chainability
     */
    detach()
    {
        this.parent.remove(this);
        this.parent = null;
        return this;
    }

    /**
     * Add a virtual directory to the list of virtual directories
     * @param {ZettlrVirtualDirectory} vd The directory to be added
     */
    addVD(vd)
    {
        // Prevent duplicates
        if(!this._vd.includes(vd)) {
            this._vd.push(vd);
        }
    }

    _notifyVD()
    {
        for(let vd of this._vd) {
            vd.update(); // Call update method
        }
    }

    /**
     * Remove a virtual directory to the list of virtual directories
     * @param {ZettlrVirtualDirectory} vd The directory to be removed
     */
    removeVD(vd)
    {
        if(this._vd.includes(vd)) {
            this._vd.splice(this._vd.indexOf(vd), 1);
        }
    }

    /**
     * Notifies all virtual directories that they can now remove this file.
     */
    removeFromVD()
    {
        for(let vd of this._vd) {
            vd.remove(this);
        }
    }

    /**
     * Search the file's content and name according to the terms-object
     * @param  {object} terms An object containing the search terms and properties
     * @return {Boolean}       true if this file matches terms or false
     */
    search(terms)
    {
        let matches = 0;

        // First match the title (faster results)
        for(let t of terms) {
            if(t.operator === 'AND') {
                if(this.name.indexOf(t.word) > -1) {
                    matches++;
                }
            } else {
                // OR operator
                for(let wd of t.word) {
                    if(this.name.indexOf(wd) > -1) {
                        matches++;
                        // Break because only one match necessary
                        break;
                    }
                }
            }
        }

        // Return immediately with an object of line -1 (indicating filename) and a huge weight
        if(matches == terms.length) { return [{line: -1, restext: this.name, 'weight': 2}]; }

        // Do a full text search.
        let cnt = this.read();
        let cntLower = cnt.toLowerCase();

        let lines = cnt.split('\n');
        let linesLower = cntLower.split('\n');
        matches = [];

        for(let t of terms) {
            if(t.operator === 'AND') {
                for(let index in lines) {
                    // Try both normal and lowercase
                    if(lines[index].indexOf(t.word) > -1) {
                        matches.push({
                            'term': t.word,
                            'from': {
                                'line': parseInt(index),
                                'ch': lines[index].indexOf(t.word)
                            },
                            'to': {
                                'line': parseInt(index),
                                'ch': lines[index].indexOf(t.word) + t.word.length
                            },
                            'weight': 1 // Weight indicates that this was an exact match
                        });
                    } else if(linesLower[index].indexOf(t.word) > -1) {
                        matches.push({
                            'term': t.word,
                            'from': {
                                'line': parseInt(index),
                                'ch': linesLower[index].indexOf(t.word)
                            },
                            'to': {
                                'line': parseInt(index),
                                'ch': linesLower[index].indexOf(t.word) + t.word.length
                            },
                            'weight': 0.5 // Weight indicates that this was an approximate match
                        });
                    }
                }
            } else {
                // OR operator.
                for(let wd of t.word) {
                    let br = false;
                    for(let index in lines) {
                        // Try both normal and lowercase
                        if(lines[index].indexOf(wd) > -1) {
                            matches.push({
                                'term': wd,
                                'from': {
                                    'line': parseInt(index),
                                    'ch': lines[index].indexOf(wd)
                                },
                                'to': {
                                    'line': parseInt(index),
                                    'ch': lines[index].indexOf(wd) + wd.length
                                },
                                'weight': 1 // Weight indicates that this was an exact match
                            });
                            br = true;
                        } else if(linesLower[index].indexOf(wd) > -1) {
                            matches.push({
                                'term': wd,
                                'from': {
                                    'line': parseInt(index),
                                    'ch': linesLower[index].indexOf(wd)
                                },
                                'to': {
                                    'line': parseInt(index),
                                    'ch': linesLower[index].indexOf(wd) + wd.length
                                },
                                'weight': 1 // Weight indicates that this was an exact match
                            });
                            br = true;
                        }
                    }
                    if(br) break;
                }
            }
        }

        return matches;
    }

    /**
     * Returns the hash of the file
     * @return {Number} The hash
     */
    getHash() { return this.hash; }

    /**
     * Returns the file path
     * @return {String} The path
     */
    getPath() { return this.path; }

    /**
     * Returns the file name
     * @return {String} The file name
     */
    getName() { return this.name; }

    // Dummy functions (either for recursive use or because their return val is obvious)

    /**
     * Dummy function for recursive use. Always returns false.
     * @return {Boolean} Always returns false.
     */
    isDirectory() { return false; }

    /**
     * Dummy function for recursive use. Always returns false.
     * @return {Boolean} Returns false.
     */
    isVirtualDirectory() { return false; }

    /**
     * Dummy function for recursive use. Always returns true.
     * @return {Boolean} Always returns true.
     */
    isFile()      { return true;  }

    /**
     * Dummy function for recursive use. Always returns false.
     * @param  {Mixed} obj Either ZettlrFile or ZettlrDir
     * @return {Boolean}     Always return false, because a file cannot contain another.
     */
    contains(obj) { return false; }

    /**
     * Dummy function for recursive use. Always returns null.
     * @param  {Mixed} obj Either ZettlrFile or ZettlrDir
     * @return {null}     Always return null.
     */
    findDir(obj)  { return null;  }

    /**
     * Returns false, if this.parent is a directory.
     * @return {Boolean} True or false depending on the type of this.parent
     */
    isRoot()      { return !this.parent.isDirectory(); }

    /**
     * Checks whether or not the given path p is in the scope of this object
     * @param  {String}  p The path to test
     * @return {Mixed}   "this" if p equals path, false otherwise.
     */
    isScope(p)
    {
        if(p === this.path) {
            return this;
        }

        return false;
    }
}

module.exports = ZettlrFile;
