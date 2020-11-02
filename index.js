/* eslint-disable no-console */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-await-in-loop */

// process.env.DEBUG='pw:api'

const { firefox } = require('playwright-firefox');
const GIFEncoder = require('gif-encoder-2')
const {createCanvas, Image} = require('canvas')
const fs = require('fs')
const AWS = require('aws-sdk')
const d3 = require('d3-dsv');

const filePathImages = '2020/11/zoo-data/stills'
const filePathGIF = '2020/11/zoo-data/output'
const filePathData = '2020/11/zoo-data'
const frameCount = 15
const frameRange = [...Array(frameCount).keys()]

const {AWS_KEY, AWS_KEY_SECRET, AWS_BUCKET} = process.env

AWS.config.update({
	maxRetries: 2,
	httpOptions: {
		timeout: 30000,
		connectTimeout: 5000
	}
})

const s3Bucket = new AWS.S3({
	accessKeyId: AWS_KEY,
	secretAccessKey: AWS_KEY_SECRET,
	region: 'us-east-1',
	params: {
		Bucket: AWS_BUCKET
	}
})

const webcams = d3.csvParse(fs.readFileSync('zoos.csv', 'utf-8'))

async function checkPlayButtons(page, play){
	const buttons = play.split(', ')
	for (const btn of buttons){
		await page.click(`${btn}`, {timeout: 10000}).catch(e => `Oops can't click: ${e}`)
	}
}



async function findVideo(page, cam){
	const {id, play} = cam
	console.log(`Preparing ${id} for screenshot`)
        
	if (play) await checkPlayButtons(page, play).catch(error => console.error(`Error clicking play buttons: ${error}`))

	// get video element playing
	await page.waitForTimeout(4000)

	const video = await page.waitForSelector('video')

	await page.$$eval('video', el => el.forEach(e => e.play()))
	if (play) await page.waitForTimeout(20000)

	// attempting to skip ad on these videos
	const nationalZoo = [20, 22, 23, 24]
	if (cam.id === 79 || cam.id === 139 || nationalZoo.includes(+cam.id)) await page.waitForTimeout(45000)
	else await page.waitForTimeout(5000)

	// const video = await page.$('video')

	return video
}

async function saveToS3(ss, videoDimensions, id, ext){
	return new Promise(async (resolve, reject) => {
		const path = ext === 'png' ? filePathImages : filePathGIF
		s3Bucket.upload({
			Key: `${path}/${id}.${ext}`,
			Body: ss, 
			Metadata: {
				'width': videoDimensions.width.toString(),
				'height': videoDimensions.height.toString()
			}
		}, (err) => {
			if (err) reject(err)
			else {
				console.log(`Successfully uploaded ${id}.${ext}`)
				resolve()
			}
		})
	})
}

async function takeScreenshots(vidEl, id){
	const allScreenshots = []

	// find video dimensions
	const videoDimensions = await vidEl.evaluate(() => ({
		width: document.documentElement.clientWidth,
		height: document.documentElement.clientHeight
	}))

	// loop through frames in sequence
	for (const frame of frameRange){
		const ss = await vidEl.screenshot({path: ''})
			.catch(error => console.error(`Error taking screenshots: ${error}`))
		const str = ss.toString('base64')

		// save all screenshots locally
		allScreenshots.push({index: frame, str, ss, id})
	}

	return {allScreenshots, videoDimensions}
}

async function processImage(file, ctx, encoder, dimensions, index, canvas){
	const image = new Image()
	const {canvasWidth, canvasHeight, width, height} = dimensions

	const imgRatio = height/width
	const canvasRatio = canvasHeight/canvasWidth

	// const x = width > canvasWidth ? (canvasWidth - width) / 2 : 0
	// const y = height > canvasHeight ? (canvasHeight - height) / 2 : 0

	let imgStr = null

	image.onload = () => {
		if (imgRatio > canvasRatio) ctx.drawImage(image, 0, (canvasHeight - height) / 2, width, height)
		else ctx.drawImage(image, (canvasWidth - width) / 2, 0, width, canvasHeight)
		// ctx.drawImage(image, x, y)
		ctx.getImageData(0, 0, canvasWidth, canvasHeight)
		
		// if on the first frame, save the new image data
		if (index === 0){
			const dataURL = canvas.toBuffer('image/png')
			 imgStr = dataURL
		}

		encoder.addFrame(ctx)
	}

	image.src = `data:image/png;base64,${file.str}`

	return imgStr
}

async function makeGIF(allScreenshots, videoDimensions, algorithm){
	const {width, height} = videoDimensions
	const canvasWidth = 500 
	const canvasHeight = 281 
	const dimensions  = {width, height, canvasWidth, canvasHeight}
        
	// setup encoder
	const encoder = new GIFEncoder(canvasWidth, canvasHeight, algorithm)

	// setup canvas
	const canvas = createCanvas(canvasWidth, canvasHeight)// .style('width', `${canvasWidth}px`).style('height', `${canvasHeight}px`)
	const ctx = canvas.getContext('2d')

	// start encoder
	encoder.start()
	encoder.setDelay(200)

	let firstStr = null

	// process images in sequence
	for (const [index, file] of allScreenshots.entries()){
		if (index === 0){
			firstStr = await processImage(file, ctx, encoder, dimensions, index, canvas).catch(error => console.error(`Error processing images for gif: ${error}`))
		}
		await processImage(file, ctx, encoder, dimensions, index, canvas).catch(error => console.error(`Error processing images for gif: ${error}`))
	}
	
	// finish encoder
	encoder.finish()
	const buffer = encoder.out.getData()

	return {gif: buffer, firstImg: firstStr}
}

async function handleError(error, browser, message){
	await browser.close()
	throw new Error(`${message}: ${error}`)
}

async function setupNationalZoo(context, cam){
	console.log('adding cookies')
	await context.addCookies([{
		'name': 'Modal-80',
		'value': 'true',
		'url': `${cam.url}`
	}
	])
		
}

async function makeZoo(cam, browser){
	let context = null

	try {
		console.log(`Getting started with ${cam.id}`)
    
		// launch browser context
		 context = await browser.newContext({viewport: {width: 640, height: 480}})
		 
		// handle special cookies for National Zoo cameras
		const nationalZoo = [20, 21, 22, 23, 24]
		if (nationalZoo.includes(+cam.id)) await setupNationalZoo(context, cam)

		// launch a single page 
		const page = await context.newPage()

		// setup page
		await page.setDefaultTimeout(20000)

		// navigate to page
		await page.goto(cam.url)

		// setup page
		page.on('crash', error => {
			handleError(error, browser, 'Page crashed')
		})
		page.on('pageerror', error => {
			handleError(error, browser, 'Page error')
		})
		page.on('dialog', async dialog => {
			console.log({message: dialog.message()})
			await dialog.dismiss()
		})

		// navigate to page and find video element
		const vidEl = await findVideo(page, cam)
        
		// take screenshots of video element
		const {allScreenshots, videoDimensions} = await takeScreenshots(vidEl, cam.id)
        
		// close browser 
		await context.close()
        
		// setup gif encoder
		const {gif, firstImg} = await makeGIF(allScreenshots, videoDimensions, 'neuquant')

		// send first screenshot to s3 for placeholder
		await saveToS3(firstImg, videoDimensions, cam.id, 'png')
	
		// send gif to s3
		await saveToS3(gif, videoDimensions, cam.id, 'gif')

		// return value to resolve
		return `finished all the things for ${cam.id}`
	} catch(error){
		await context.close()
		console.error(`Error making zoos: ${error}`)
		return `oops, ${cam.id} failed`
	}
}

async function collectData(id){
	const cam = {id, timestamp: null}
	const timestamp = Date.now()
	cam.timestamp = timestamp

	return cam
}

async function writeData(data){
	return new Promise(async (resolve, reject) => {
		s3Bucket.upload({
			Key: `${filePathData}/timestamps.json`,
			Body: data
		}, (err) => {
			if (err) reject(err)
			else {
				console.log('Successfully uploaded timestamps.json')
				resolve()
			}
		})
	})
}

(async function loopThroughCams(){
	const sa = [0, 2, 90]
	const sub = webcams// .filter(d => sa.includes(+d.id))

	// setup for saving timestamp data
	const data = []
	// launch headless browser
	const browser = await firefox.launch({headless: true,  timeout: 20000, args: ['--no-sandbox']})
    
	for (const [index, cam] of sub.entries()){
		await makeZoo(cam, browser).catch(error => console.error(`Error getting zoos: ${error}`))
		const str = await collectData(cam.id).catch(error => console.error(`Error collecting data: ${error}`))
		data.push(str)

		if (index === sub.length - 1) {
			await browser.close()
			const allStr = JSON.stringify(data)
			await writeData(allStr).catch(error => console.error(`Error writing data: ${error}`))
		}
	}

	console.log('for loop finished!')
})().catch(error => console.error(`Error looping through cams: ${error}`))
