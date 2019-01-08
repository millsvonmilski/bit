/** @flow */
import R from 'ramda';
import path from 'path';
import type Component from '../consumer/component/consumer-component';
import logger from '../logger/logger';
import { pathNormalizeToLinux } from '../utils';
import * as linkGenerator from '../links/link-generator';
import linkComponentsToNodeModules, { NodeModuleLinker } from './node-modules-linker';
import type Consumer from '../consumer/consumer';
import ComponentWithDependencies from '../scope/component-dependencies';
import * as packageJson from '../consumer/component/package-json';
import type { LinksResult } from './node-modules-linker';
import GeneralError from '../error/general-error';
import ComponentMap from '../consumer/bit-map/component-map';
import { LinkFile } from '.';
import DataToPersist from '../consumer/component/sources/data-to-persist';

export async function linkAllToNodeModules(consumer: Consumer): Promise<LinksResult[]> {
  const componentsIds = consumer.bitmapIds;
  if (R.isEmpty(componentsIds)) throw new GeneralError('nothing to link');
  const { components } = await consumer.loadComponents(componentsIds);
  return linkComponentsToNodeModules(components, consumer);
}

export async function writeLinksInDist(component: Component, componentMap: ComponentMap, consumer: Consumer) {
  const componentWithDeps = await component.toComponentWithDependencies(consumer);
  await linkGenerator.writeComponentsDependenciesLinks([componentWithDeps], consumer, false);
  const newMainFile = pathNormalizeToLinux(component.dists.calculateMainDistFile(component.mainFile));
  if (!componentMap.rootDir) throw new GeneralError('writeLinksInDist should get called on imported components only');
  await packageJson.updateAttribute(consumer, componentMap.rootDir, 'main', newMainFile);
  await linkComponentsToNodeModules([component], consumer);
  return linkGenerator.writeEntryPointsForComponent(component, consumer);
}

export async function getLinksInDistToWrite(
  componentWithDeps: ComponentWithDependencies,
  componentMap: ComponentMap,
  consumer?: Consumer
) {
  const files = [];
  const symlinks = [];
  const component: Component = componentWithDeps.component;
  const outputFileParams = await linkGenerator.getComponentsDependenciesLinks([componentWithDeps], consumer, false);
  outputFileParams.map(outputFile => files.push(LinkFile.load(outputFile)));
  const newMainFile = pathNormalizeToLinux(component.dists.calculateMainDistFile(component.mainFile));
  if (!componentMap.rootDir) throw new GeneralError('writeLinksInDist should get called on imported components only');
  // await packageJson.updateAttribute(consumer, componentMap.rootDir, 'main', newMainFile);
  const packageJsonFile = component.dataToPersist.files.find(
    f => f.relative === path.join(componentMap.rootDir, 'package.json')
  );
  if (packageJsonFile) {
    const packageJsonParsed = JSON.parse(packageJsonFile.contents);
    packageJsonParsed.main = newMainFile;
    packageJsonFile.contents = new Buffer(JSON.stringify(packageJson, null, 4));
  }
  // await linkComponentsToNodeModules([component], consumer);
  const nodeModuleLinker = new NodeModuleLinker([component], consumer);
  const results = await nodeModuleLinker.getLinks();
  files.push(...results.files);
  symlinks.push(...results.symlinks);
  const entryPoints = linkGenerator.getEntryPointsForComponent(component, consumer);
  files.push(...entryPoints);
}

async function reLinkDirectlyImportedDependencies(components: Component[], consumer: Consumer): Promise<void> {
  logger.debug(`reLinkDirectlyImportedDependencies: found ${components.length} components to re-link`);
  const componentsWithDependencies = await Promise.all(
    components.map(component => component.toComponentWithDependencies(consumer))
  );
  await linkGenerator.writeComponentsDependenciesLinks(componentsWithDependencies, consumer, false);
  await linkComponentsToNodeModules(components, consumer);
}

async function getReLinkDirectlyImportedDependenciesLinks(
  components: Component[],
  consumer: Consumer
): Promise<Object> {
  logger.debug(`reLinkDirectlyImportedDependencies: found ${components.length} components to re-link`);
  const componentsWithDependencies = await Promise.all(
    components.map(component => component.toComponentWithDependencies(consumer))
  );
  const componentsDependenciesLinks = await linkGenerator.getComponentsDependenciesLinks(
    componentsWithDependencies,
    consumer,
    false
  );
  const componentsDependenciesLinkFiles = componentsDependenciesLinks.map(l => LinkFile.load(l));
  const nodeModuleLinker = new NodeModuleLinker(components, consumer);
  const nodeModuleLinks = await nodeModuleLinker.getLinks();
  return { files: [...componentsDependenciesLinkFiles, ...nodeModuleLinks.files], symlinks: nodeModuleLinks.symlinks };
}

/**
 * needed for the following cases:
 * 1) user is importing a component directly which was a dependency before. (before: IMPORTED, now: NESTED).
 * 2) user used bit-move to move a dependency to another directory.
 * as a result of the cases above, the link from the dependent to the dependency is broken.
 * find the dependents components and re-link them
 */
export async function reLinkDependents(consumer: Consumer, components: Component[]): Promise<void> {
  logger.debug('linker: check whether there are direct dependents for re-linking');
  const directDependentComponents = await consumer.getAuthoredAndImportedDependentsOfComponents(components);
  if (directDependentComponents.length) {
    await reLinkDirectlyImportedDependencies(directDependentComponents, consumer);
    await packageJson.changeDependenciesToRelativeSyntax(consumer, directDependentComponents, components);
  }
}

/**
 * needed for the following cases:
 * 1) user is importing a component directly which was a dependency before. (before: IMPORTED, now: NESTED).
 * 2) user used bit-move to move a dependency to another directory.
 * as a result of the cases above, the link from the dependent to the dependency is broken.
 * find the dependents components and re-link them
 */
export async function getReLinkDependentsData(consumer: Consumer, components: Component[]): Promise<Object> {
  logger.debug('linker: check whether there are direct dependents for re-linking');
  const directDependentComponents = await consumer.getAuthoredAndImportedDependentsOfComponents(components);
  const files = [];
  const symlinks = [];
  if (directDependentComponents.length) {
    const data = await getReLinkDirectlyImportedDependenciesLinks(directDependentComponents, consumer);
    const packageJsonFiles = await packageJson.changeDependenciesToRelativeSyntax(
      consumer,
      directDependentComponents,
      components
    );
    files.push(...data.files, ...packageJsonFiles);
    symlinks.push(...data.symlinks);
  }
  return { files, symlinks };
}

/**
 * link the components after import.
 * this process contains the following steps:
 * 1) writing link files to connect imported components to their dependencies
 * 2) writing index.js files (entry-point files) in the root directories of each one of the imported and dependencies components.
 * unless writePackageJson is true, because if package.json is written, its "main" attribute points to the entry-point.
 * 3) creating symlinks from components directories to node_modules
 * 4) in case a component was nested and now imported directly, re-link its dependents
 */
export async function linkComponents({
  componentsWithDependencies,
  writtenComponents,
  writtenDependencies,
  consumer,
  createNpmLinkFiles,
  writePackageJson
}: {
  componentsWithDependencies: ComponentWithDependencies[],
  writtenComponents: Component[],
  writtenDependencies: ?(Component[]),
  consumer: Consumer,
  createNpmLinkFiles: boolean,
  writePackageJson: boolean
}) {
  await linkGenerator.writeComponentsDependenciesLinks(componentsWithDependencies, consumer, createNpmLinkFiles);
  // no need for entry-point file if package.json is written.
  if (writtenDependencies) {
    await Promise.all(
      R.flatten(writtenDependencies).map(component => linkGenerator.writeEntryPointsForComponent(component, consumer))
    );
  }
  if (!writePackageJson) {
    await Promise.all(
      writtenComponents.map(component => linkGenerator.writeEntryPointsForComponent(component, consumer))
    );
  }
  const allComponents = writtenDependencies
    ? [...writtenComponents, ...R.flatten(writtenDependencies)]
    : writtenComponents;
  await linkComponentsToNodeModules(allComponents, consumer);
  await reLinkDependents(consumer, writtenComponents);
  return allComponents;
}

/**
 * link the components after import.
 * this process contains the following steps:
 * 1) writing link files to connect imported components to their dependencies
 * 2) writing index.js files (entry-point files) in the root directories of each one of the imported and dependencies components.
 * unless writePackageJson is true, because if package.json is written, its "main" attribute points to the entry-point.
 * 3) creating symlinks from components directories to node_modules
 * 4) in case a component was nested and now imported directly, re-link its dependents
 */
export async function getAllComponentsLinks({
  componentsWithDependencies,
  writtenComponents,
  writtenDependencies,
  consumer,
  createNpmLinkFiles,
  writePackageJson
}: {
  componentsWithDependencies: ComponentWithDependencies[],
  writtenComponents: Component[],
  writtenDependencies: ?(Component[]),
  consumer: Consumer,
  createNpmLinkFiles: boolean,
  writePackageJson: boolean
}): Promise<DataToPersist> {
  const files = [];
  const symlinks = [];
  const componentsDependenciesLinks = await linkGenerator.getComponentsDependenciesLinks(
    componentsWithDependencies,
    consumer,
    createNpmLinkFiles
  );
  const componentsDependenciesLinkFiles = componentsDependenciesLinks.map(l => LinkFile.load(l));

  if (writtenDependencies) {
    const entryPoints = R.flatten(writtenDependencies).map(component =>
      linkGenerator.getEntryPointsForComponent(component, consumer)
    );
    files.push(...R.flatten(entryPoints));
  }
  if (!writePackageJson) {
    // no need for entry-point file if package.json is written.
    const entryPoints = writtenComponents.map(component =>
      linkGenerator.getEntryPointsForComponent(component, consumer)
    );
    files.push(...R.flatten(entryPoints));
  }
  const allComponents = writtenDependencies
    ? [...writtenComponents, ...R.flatten(writtenDependencies)]
    : writtenComponents;
  const nodeModuleLinker = new NodeModuleLinker(allComponents, consumer);
  const nodeModuleLinks = await nodeModuleLinker.getLinks();
  const reLinkDependentsData = await getReLinkDependentsData(consumer, writtenComponents);
  files.push(...componentsDependenciesLinkFiles, ...nodeModuleLinks.files, ...reLinkDependentsData.files);
  symlinks.push(...nodeModuleLinks.symlinks, ...reLinkDependentsData.symlinks);
  return DataToPersist.makeInstance({ files, symlinks });
}
