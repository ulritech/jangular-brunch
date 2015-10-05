/**
 */
'use strict';

var fs = require('fs'),
	path = require('path');

var _ = require('lodash'),
	anymatch = require('anymatch'),
	jade = require('jade'),
	mkdirp = require('mkdirp');

function JangularBrunchPlugin(brunchConfig) {
	this.brunchConfig_ = brunchConfig;
	this.config_ = brunchConfig.plugins.jangular || {};

	this.singleMatchers_ = [];			// anymatch instances for single files
	this.bundles_ = [];
	this.changedBundleFiles_ = [];		// collection of files that have changed on each compile
	this.compiledFileCache_ = {};		// cache of compiled jade files {file => template}

	// ------------------------------------------
	// Initialization
	this.initSingles_();
	this.initBundles_();
	this.initJadeOptions_();
}

JangularBrunchPlugin.prototype.initSingles_ = function() {
	if (!this.config_.singles)
		return;

	var isArray = this.config_.singles instanceof Array;
	if (!isArray)
		throw new Error('jangular.singles must be an array of strings or anymatch patterns');

	var self = this;
	this.config_.singles.forEach(function(pattern) {
		self.singleMatchers_.push(anymatch(pattern));
	});
};

JangularBrunchPlugin.prototype.initBundles_ = function() {
	if (!this.config_.bundles)
		return;

	if (typeof this.config_.bundles !== 'object')
		throw new Error('jangular.bundles property must be an object');

	var self = this;
	Object.keys(this.config_.bundles).forEach(function(bundlePath) {
		var bundle = self.config_.bundles[bundlePath];
		if (!bundle.module)
			throw new Error('Missing module name for bundle:', bundlePath);

		self.bundles_.push({
			targetFile: bundlePath,
			matcher: anymatch(bundle.pattern),
			module: bundle.module
		});
	});
};

JangularBrunchPlugin.prototype.initJadeOptions_ = function() {
	this.jadeOptions_ = this.config_.jadeOptions ? _.cloneDeep(this.config_.jadeOptions) : {};
	_.defaults(this.jadeOptions_, {
		doctype: '5'
	});

	// Convert any numeric doctype to a string because jade will attempt to call
	// toLowerCase() on this value and if not a string, it will throw an error
	if (this.jadeOptions_.doctype)
		this.jadeOptions_.doctype += '';

	// Unless specified otherwise, do not make pretty if optimize is true
	if (!this.jadeOptions_.hasOwnProperty('pretty'))
		this.jadeOptions_.pretty = !this.brunchConfig_.optimize;
};


// ----------------------------------------------
// Brunch plugin configuration
JangularBrunchPlugin.prototype.brunchPlugin = true;

JangularBrunchPlugin.prototype.extension = 'jade';

JangularBrunchPlugin.prototype.type = 'template';

JangularBrunchPlugin.prototype.compile = function(data, file, done) {
	var isSingle = this.isSingle_(file),
		belongsToBundle = this.belongsToBundle_(file);
	if (!isSingle && !belongsToBundle)
		return null;

	try {
		this.jadeOptions_.filename = file;
		var templateFn = jade.compile(data, this.jadeOptions_),
			template = templateFn(this.config_.locals),
			basename = path.basename(file, '.jade'),
			partialDir = this.stripRoot_(path.dirname(file));

		if (isSingle) {
			var targetFilename = basename + '.html',
				targetFile = path.resolve(this.brunchConfig_.paths['public'], partialDir, targetFilename);
			mkdirp.sync(path.dirname(targetFile));
			fs.writeFileSync(targetFile, template);
			console.info('\tCompiled:', file, '-->', targetFile);
		}
		else {
			// Slightly tweak the template output to accommodate being output via strings
			template = template.trim()		// Remove the beginning newline character Jade includes
				.replace(/\n/g, '\\n')		// And escape any newlines
				.replace(/'/g, "\\'");		// Escape all single quotes

			// Keep track of which file changed
			this.changedBundleFiles_.push(file);

			// Save the compiled template for future use
			this.compiledFileCache_[file] = template;
		}

		done(null, template);
	}
	catch (compileError) {
		done(compileError, data);
	}
};

JangularBrunchPlugin.prototype.onCompile = function(generatedFiles) {
	var self = this,
		finalJadeTemplates = this.matchingGeneratedFileList_(generatedFiles);
	if (finalJadeTemplates.length === 0)
		return;

	var deletedTemplates = this.findDeletedTemplates_(finalJadeTemplates),
		changedFiles = this.findDeletedTemplates_(finalJadeTemplates).concat(this.changedBundleFiles_),
		changedBundles = this.bundlesContaining_(changedFiles);

	deletedTemplates.forEach(function(file) {
		delete self.compiledFileCache_[file];
		console.log('\tRemoved from cache:', file);
	});

	changedBundles.forEach(function(bundle) {
		self.writeBundle_(bundle);
	});

    this.changedBundleFiles_.length = 0;
};

JangularBrunchPlugin.prototype.isSingle_ = function(file) {
	for (var i = 0; i < this.singleMatchers_.length; i++)
		if (this.singleMatchers_[i](file))
			return true;

	return false;
};

JangularBrunchPlugin.prototype.belongsToBundle_ = function(file) {
	for (var i = 0; i < this.bundles_.length; i++)
		if (this.bundles_[i].matcher(file))
			return true;

	return false;
};

JangularBrunchPlugin.prototype.bundlesContaining_ = function(files) {
	var members = [];
	if (files.length) {
		this.bundles_.forEach(function(bundleMatcher) {
			for (var i = 0; i< files.length; i++) {
				if (bundleMatcher.matcher(files[i])) {
					members.push(bundleMatcher);
					return;
				}
			}
		});
	}
	return members;
};

JangularBrunchPlugin.prototype.matchingGeneratedFileList_ = function(generatedFiles) {
	var self = this,
		result = [];

	generatedFiles.forEach(function(generatedFile) {
		generatedFile.sourceFiles.forEach(function(sourceFileObj) {
			var sourceFile = sourceFileObj.path;
			if (path.extname(sourceFile) === '.' + self.extension)
				result.push(sourceFile);
		});
	});
	return result;
};

JangularBrunchPlugin.prototype.findDeletedTemplates_ = function(finalJadeTemplates) {
	var currentJadeTemplates = Object.keys(this.compiledFileCache_);
	return _.difference(currentJadeTemplates, finalJadeTemplates);
};

JangularBrunchPlugin.prototype.writeBundle_ = function(bundle) {
	var bundleString = "angular.module('" + bundle.module + "', [])\n" +
		".run(['$templateCache', function($templateCache) {\n";

	for (var file in this.compiledFileCache_) {
		if (bundle.matcher(file)) {
			var templateName = this.stripRoot_(file),
				templateContents = this.compiledFileCache_[file];

			// All template names in the cache must begin with forward slashes
			templateName = templateName.replace(/\\/g, '/');
			
			bundleString += "\t$templateCache.put('" + templateName + "', '" +
				templateContents + "');\n";
		}
	}
	bundleString += "}]);\n";

	var outFile = path.resolve(this.brunchConfig_.paths['public'], bundle.targetFile);
	mkdirp.sync(path.dirname(outFile));
	var outFd = fs.openSync(outFile, 'w');
	fs.writeSync(outFd, bundleString);
	fs.closeSync(outFd);

	console.log('\tCompiled module:', bundle.module, 'into', bundle.targetFile);
};

JangularBrunchPlugin.prototype.stripRoot_ = function(subject) {
	return stripFromBeginning(subject, this.config_.root);
};

function stripFromBeginning(subject, query) {
	if (!query)
		return subject;

	if (subject.indexOf(query) === 0)
		return subject.substr(query.length);

	return subject;
}

module.exports = JangularBrunchPlugin;
